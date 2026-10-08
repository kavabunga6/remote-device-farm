# Запуск Maestro на устройстве фермы

[Все интеграции и их статус](README.md) · [API и CLI](../api/README.md)

Существующие Maestro flows можно запускать на удалённом Android через ADB. Ферма выделяет устройство, CLI подключает его и передаёт адрес тестовой команде.

## Размеры памяти устройства и параметры запуска

Все настройки передаются через общий CLI: `RDF_DISK_GB` — внутренняя память Android, `RDF_SD_CARD_MB` — SD-карта, `RDF_EMULATOR_PARAMS` — дополнительные разрешённые аргументы. Они задаются до `rdf.sh run`; [значения и ограничения](../api/README.md#память-устройства-sd-карта-и-аргументы-запуска) совпадают с веб-интерфейсом.

## Что нужно

- Bash, `curl`, `jq`, GNU `timeout`, `adb` и установленный [Maestro CLI](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli).
- Доступ к HTTPS фермы и её ADB-портам через доверенную сеть или VPN.
- Личный API-токен и публичный ADB-ключ в аккаунте фермы. Закрытая часть должна быть загружена локальным ADB-сервером до запуска.
- Для тестирования своего приложения — APK и flow, например `.maestro/smoke.yaml`. Проверку подключения можно выполнить без своего APK, как описано ниже.

Скопируйте [rdf.sh](../../scripts/rdf.sh) в `ci/rdf.sh` репозитория приложения.

## Первый запуск

```sh
export RDF_URL='https://farm.example.com'
export RDF_PROFILE='android-30'
export RDF_ADB_KEY_ID='33333333-3333-4333-8333-333333333333'
read -rsp 'API-токен: ' RDF_TOKEN
printf '\n'
export RDF_TOKEN

bash ci/rdf.sh run -- bash -c '
  set -euo pipefail
  env -u RDF_TOKEN adb -s "$ANDROID_SERIAL" install -r app/build/outputs/apk/debug/app-debug.apk
  env -u RDF_TOKEN maestro --device "$ANDROID_SERIAL" test .maestro/smoke.yaml
'
```

Замените ID профиля и ключа значениями своей фермы. Путь APK зависит от варианта сборки приложения.

Вложенный `bash -c` нужен, чтобы `$ANDROID_SERIAL` раскрылся **после** подключения устройства. Аргумент `--device` — глобальный параметр Maestro, он находится перед `test`. [Справочник Maestro CLI](https://docs.maestro.dev/maestro-cli/maestro-cli-commands-and-options).

## Проверить ферму без своего APK

В репозитории есть [короткий flow для Android Settings](../../examples/maestro/settings-smoke.yaml). Он открывает встроенные настройки, проверяет пункт «Сеть и Интернет» и сохраняет скриншот `settings-home.png`. Flow рассчитан на Android 11 для телефона или планшета с английским или русским интерфейсом. Он не меняет настройки и не очищает данные приложения.

Скопируйте flow в `examples/maestro/settings-smoke.yaml` репозитория приложения. Настройте переменные `RDF_URL`, `RDF_PROFILE`, `RDF_ADB_KEY_ID` и `RDF_TOKEN`, как в примере выше, затем выполните:

```bash
bash ci/rdf.sh run -- bash -c 'env -u RDF_TOKEN maestro --device "$ANDROID_SERIAL" test examples/maestro/settings-smoke.yaml'
```

Если запускаете проверку прямо из корня репозитория фермы, копировать файлы не нужно:

```bash
bash scripts/rdf.sh run -- bash -c 'env -u RDF_TOKEN maestro --device "$ANDROID_SERIAL" test examples/maestro/settings-smoke.yaml'
```

CLI выделит устройство, дождётся готовности ADB и передаст адрес Maestro. После теста он дождётся освобождения сессии. Maestro установит на устройство свои служебные тестовые компоненты; APK вашего приложения для этой проверки не нужен.

## Сохранить JUnit и logcat

Для CI удобнее вынести команды в `ci/maestro-tests.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts
collect_logs() {
  result=$?
  trap - EXIT
  bash ci/rdf.sh logs 2000 > artifacts/logcat.txt || true
  exit "$result"
}
trap collect_logs EXIT

env -u RDF_TOKEN adb -s "$ANDROID_SERIAL" install -r app/build/outputs/apk/debug/app-debug.apk
env -u RDF_TOKEN maestro --device "$ANDROID_SERIAL" test \
  --format JUNIT --output artifacts/maestro.xml .maestro/
```

Запуск:

```sh
bash ci/rdf.sh run -- bash ci/maestro-tests.sh
```

Maestro и ADB не получают API-токен. Он остаётся в скрипте-обёртке для сбора logcat.

После команды сохраните каталог `artifacts/` средствами своей CI. Устройство уже будет освобождено. При ошибке очистки останется файл состояния, путь которого CLI напечатал перед запуском; его можно передать следующему `release`.

## Параллельные тесты и ограничения

Каждому заданию нужны отдельная сессия, файл состояния и ADB-окружение. Для первой настройки используйте выделенный runner с одной задачей одновременно.

**Maestro 2.11.0 ищет устройства через локальный ADB-сервер на стандартном порту 5037.** Переменная `ANDROID_ADB_SERVER_PORT` не меняет порт поиска для `--device`. Поэтому ADB и Maestro должны видеть устройство через один сервер на 5037. Для изоляции заданий используйте отдельные runner-окружения. Это ограничение подтверждается [кодом `AndroidDeviceConnection.byId`](https://github.com/mobile-dev-inc/Maestro/blob/cli-2.11.0/maestro-client/src/main/java/maestro/android/AndroidDeviceConnection.kt) и отслеживается в [задаче Maestro №3461](https://github.com/mobile-dev-inc/Maestro/issues/3461).

Не вызывайте общий `adb kill-server`: это оборвёт подключения других заданий.

Управляемый запуск поддерживает аренду во время тестов. Если CLI исчезнет, продление прекратится, а сервер запросит остановку по сроку аренды. При недоступном агенте окончательная очистка ждёт его возвращения.

## Если flow не запускается

- **Устройство не найдено:** CLI и Maestro должны видеть один адрес через ADB-сервер на порту 5037. Проверьте `adb devices` и значение `ANDROID_SERIAL`.
- **`unauthorized`:** публичный ключ с ID `RDF_ADB_KEY_ID` должен соответствовать закрытому ключу, используемому вашим ADB-сервером.
- **Не найден пункт настроек:** встроенный smoke-тест рассчитан на Android 11 с русским или английским интерфейсом. Для другой версии, языка или TV измените селектор flow.
- **Нет отчёта JUnit:** проверьте, был ли запущен Maestro и указан ли `--format JUNIT --output ...`; ошибка очереди или подключения могла произойти раньше.

Отмена и восстановление незавершённой сессии описаны в [общем руководстве](README.md#отмена-ошибки-и-повторное-освобождение). Отдельного плагина Maestro в репозитории нет: используется обычный CLI и flow.

## Проверенный сценарий

Пример `examples/maestro/settings-smoke.yaml` проверен на Android 11 с Maestro 2.11.0: открытие настроек, проверка элемента интерфейса и снимок экрана. CLI выделяет сессию через очередь, подключает ADB и после теста освобождает устройство.

Совместимость выбранного образа, APK и сценариев приложения проверяется отдельно. Статус других интеграций находится в [общем руководстве](README.md).
