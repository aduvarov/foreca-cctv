#!/usr/bin/env bash
# Установка сервиса как пользовательского юнита systemd.
#
# Зачем: после падения Node (например, EPIPE от умершего FFmpeg) поднимать
# сервис должен супервизор, а не человек. Заодно сервис переживает перезагрузку.
#
# Запуск: ./scripts/install-service.sh
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_path="$unit_dir/foreca-cctv.service"
node_bin="$(command -v node)"
config_path="$repo_dir/config.json"

if [[ ! -f "$config_path" ]]; then
  echo "нет $config_path: сначала запустите мастер настройки (npm start)" >&2
  exit 1
fi

if [[ ! -f "$repo_dir/dist/index.js" ]]; then
  echo "нет dist/index.js: соберите сервис командой npm run build" >&2
  exit 1
fi

mkdir -p "$unit_dir"

# Пути подставляются из окружения: юнит в репозитории — образец, а не готовый
# файл, потому что путь к node у nvm меняется вместе с версией.
sed \
  -e "s|__NODE__|$node_bin|g" \
  -e "s|__REPO__|$repo_dir|g" \
  -e "s|__CONFIG__|$config_path|g" \
  "$repo_dir/deploy/foreca-cctv.service.in" >"$unit_path"

systemctl --user daemon-reload

# Linger нужен, чтобы юнит работал без активной сессии пользователя.
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != "yes" ]]; then
  echo "включаю linger для $USER (нужен для работы без входа в систему)"
  loginctl enable-linger "$USER" || echo "не удалось включить linger: включите вручную" >&2
fi

systemctl --user enable --now foreca-cctv.service
systemctl --user --no-pager status foreca-cctv.service || true

echo
echo "журнал: journalctl --user -u foreca-cctv -f"
echo "состояние: curl -s http://127.0.0.1:9970/health"
