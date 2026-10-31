#!/usr/bin/env bash
# Диагностика потока foreca-cctv для регистратора.
#
# Отвечает на вопрос «почему NVR не видит камеру» по порядку:
# от процесса до параметров, которые NVR проверяет первым делом.
#
# Важно про ffprobe: поток идёт с частотой 1 кадр в секунду, и на наборе пробы
# он легко тратит 8 секунд. Поэтому везде отключён анализ входа — иначе
# проверка ложно сообщает «TCP не отвечает».
#
# Запуск: ./scripts/check-stream.sh [host] [port] [path]
#   HEALTH_PORT=9970 — порт локального health-сервера.

set -uo pipefail

HOST="${1:-127.0.0.1}"
PORT="${2:-8554}"
PATH_NAME="${3:-weather}"
HEALTH_PORT="${HEALTH_PORT:-9970}"

# Быстрый пробник: без набора пробы и анализа входа.
probe() {
  local transport="$1"
  shift
  timeout 12 ffprobe -v error -rtsp_transport "$transport" \
    -analyzeduration 0 -probesize 32 "$@" 2>&1
}

fail=0
note() { printf '  %s\n' "$*"; }
ok() { printf '[ OK ] %s\n' "$*"; }
warn() { printf '[ !! ] %s\n' "$*"; }
bad() { printf '[FAIL] %s\n' "$*"; fail=1; }

echo "Проверка потока rtsp://${HOST}:${PORT}/${PATH_NAME}"
echo

echo '1. Локальное состояние сервиса'
if command -v curl >/dev/null; then
  if health=$(curl -fsS -m 3 "http://127.0.0.1:${HEALTH_PORT}/health" 2>/dev/null); then
    note "$health"
    if printf '%s' "$health" | grep -q '"streaming":true'; then
      ok 'публикация активна'
    else
      bad 'публикации нет: сервис не вещает'
    fi
  else
    warn "health недоступен на 127.0.0.1:${HEALTH_PORT} (сервис не запущен?)"
  fi
else
  note 'curl не найден, шаг пропущен'
fi
echo

echo '2. Доступность RTSP по TCP'
if [ -n "$(probe tcp -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "rtsp://${HOST}:${PORT}/${PATH_NAME}")" ]; then
  ok 'TCP работает'
else
  bad 'TCP не отвечает: проверьте хост, порт и файрвол'
fi
echo

echo '3. Параметры, важные для аппаратного регистратора'
stream_json=$(probe tcp -select_streams v:0 -show_streams -of json "rtsp://${HOST}:${PORT}/${PATH_NAME}")

if [ -n "$stream_json" ]; then
  read_json() {
    printf '%s' "$stream_json" | python3 -c "import sys,json;print(json.load(sys.stdin)['streams'][0].get('$1',''))" 2>/dev/null
  }
  profile=$(read_json profile)
  level=$(read_json level)
  pix_fmt=$(read_json pix_fmt)
  fps=$(read_json avg_frame_rate)
  extradata=$(read_json extradata_size)
  bframes=$(read_json has_b_frames)
  width=$(read_json width)
  height=$(read_json height)

  ok "размер: ${width}x${height}, частота: ${fps}"
  [ "$profile" = 'Main' ] && ok "профиль: ${profile}" || warn "профиль: ${profile} (ожидается Main)"
  [ "$level" = '31' ] && ok "уровень: ${level} (3.1)" || warn "уровень: ${level} (ожидается 31)"
  [ "$pix_fmt" = 'yuv420p' ] && ok "формат пикселей: ${pix_fmt}" || bad "формат пикселей: ${pix_fmt} (нужен yuv420p)"
  [ "$bframes" = '0' ] && ok 'B-кадров нет' || warn "B-кадры: ${bframes}"
  if [ -n "$extradata" ] && [ "$extradata" != '0' ]; then
    ok "SPS/PPS присутствуют (${extradata} байт)"
  else
    bad 'нет SPS/PPS: регистратор не запустит декодер'
  fi
else
  bad 'не удалось прочитать параметры потока'
fi
echo

echo '4. Первый кадр — ключевой'
first_frame=$(probe tcp -select_streams v:0 -read_intervals '%+#3' \
  -show_entries frame=key_frame,pict_type -of csv=p=0 "rtsp://${HOST}:${PORT}/${PATH_NAME}" | head -1)
case "$first_frame" in
  1,I*) ok "первый кадр: ${first_frame}" ;;
  '') warn 'не удалось прочитать кадры' ;;
  *) warn "первый кадр: ${first_frame} (нужен ключевой)" ;;
esac
echo

echo '5. UDP (часть регистраторов просит именно его)'
if [ -n "$(probe udp -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "rtsp://${HOST}:${PORT}/${PATH_NAME}")" ]; then
  ok 'UDP работает'
else
  warn 'UDP не поддерживается.'
  note 'Включите udp в rtspTransports в mediamtx.yml и откройте 8000-8001/udp.'
  note 'Без UDP регистратор, который просит только UDP, получит 461 Unsupported Transport.'
fi
echo

echo '6. Вторая ссылка'
if [ -n "$(probe tcp -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "rtsp://${HOST}:${PORT}/${PATH_NAME}_sub")" ]; then
  ok "${PATH_NAME}_sub доступна"
else
  bad "${PATH_NAME}_sub недоступна"
fi
echo

if [ "$fail" -eq 0 ]; then
  echo 'Итог: параметры потока пригодны для регистратора.'
else
  echo 'Итог: есть проблемы, см. [FAIL] выше.'
fi
exit "$fail"
