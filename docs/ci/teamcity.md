# Android-тесты в TeamCity

[Все интеграции и их статус](README.md) · [API и CLI](../api/README.md) · [Maestro](maestro.md)

Пример использует обычный [Command Line build step](https://www.jetbrains.com/help/teamcity/command-line.html) в репозитории Android-приложения. Shell-скрипт собирает APK, затем вызывает `ci/rdf.sh run`: CLI ждёт устройство в очереди, подключает ADB, продлевает аренду во время тестов и освобождает устройство.

## Размеры памяти устройства и параметры запуска

Все настройки передаются через общий CLI: `RDF_DISK_GB` — внутренняя память Android, `RDF_SD_CARD_MB` — SD-карта, `RDF_EMULATOR_PARAMS` — дополнительные разрешённые аргументы. Они задаются до `rdf.sh run`; [значения и ограничения](../api/README.md#память-устройства-sd-карта-и-аргументы-запуска) совпадают с веб-интерфейсом.

В TeamCity используйте параметры `env.RDF_DISK_GB`, `env.RDF_SD_CARD_MB`, `env.RDF_EMULATOR_PARAMS`. Оставьте их незаданными, чтобы наследовать профиль; не задавайте пустую строку для числовых размеров.

## Подготовить агент и файлы

Нужен выделенный Linux-агент с Bash, `curl`, `jq`, GNU `timeout`, `tee`, `adb`, JDK и Android SDK проекта. Настройте доступ к HTTPS фермы и её ADB-портам через доверенную сеть или VPN.

Создайте в ферме CI-аккаунт, личный API-токен и публичный ADB-ключ. Парный закрытый ключ должен быть заранее доступен локальному ADB-серверу под пользователем агента. В параметрах сборки укажите ID именно этого публичного ключа.

Выделите отдельный agent pool либо задайте agent requirements для подготовленных Linux-агентов. Не запускайте несколько TeamCity-агентов с общим ADB-сервером на одном хосте. Для параллельных сборок нужны отдельные ADB-окружения и домашние каталоги; отдельного имени файла состояния для изоляции ADB недостаточно.

Скопируйте файлы с окончаниями строк LF:

| Файл фермы | Путь в репозитории приложения |
| --- | --- |
| [scripts/rdf.sh](../../scripts/rdf.sh) | `ci/rdf.sh` |
| [examples/teamcity/run-tests.sh](../../examples/teamcity/run-tests.sh) | `ci/teamcity-tests.sh` |
| [examples/teamcity/android-tests.sh](../../examples/teamcity/android-tests.sh) | `ci/android-tests.sh` |

Проверьте право выполнения `gradlew` в Git. Добавьте `rdf-artifacts/` в `.gitignore` приложения. Shell-файлы вызываются через Bash.

## Параметры Build Configuration

В **Parameters** добавьте:

| Имя | Тип значения | Значение |
| --- | --- | --- |
| `env.RDF_URL` | Text | `https://farm.example.com` — адрес вашей фермы |
| `env.RDF_PROFILE` | Text | ID профиля, например `android-30` |
| `env.RDF_ADB_KEY_ID` | Text | UUID публичного ADB-ключа CI-аккаунта |
| `env.RDF_TOKEN` | **Password** | Личный API-токен CI-аккаунта |
| `env.RDF_CI_BUILD_ID` | Text | `%system.teamcity.build.id%` |

Префикс `env.` [передаёт параметр в окружение процесса](https://www.jetbrains.com/help/teamcity/configuring-build-parameters.html). Для секрета выберите [тип Password](https://www.jetbrains.com/help/teamcity/typed-parameters.html); скрипт читает `$RDF_TOKEN` и отключает трассировку. Не подставляйте `%env.RDF_TOKEN%` в текст команды и не печатайте окружение.

`system.teamcity.build.id` — [внутренний уникальный ID сборки](https://www.jetbrains.com/help/teamcity/predefined-build-parameters.html). Скрипт использует его для каталога `rdf-artifacts/<ID>/`, где сохраняет логи и `session.json`. Настраиваемый пользователем `BUILD_NUMBER` для этого не требуется.

## Command Line шаг

В **Build Steps** создайте шаг:

- **Runner type:** Command Line.
- **Run:** Custom script.
- **Working directory:** корень checkout репозитория приложения.
- **Custom script:**

```bash
#!/usr/bin/env bash
set +x
exec bash ci/teamcity-tests.sh
```

Внешний shell-файл хранится в репозитории: его содержимое не требует экранировать символы `%` как в поле Custom script. Специальный плагин фермы и Kotlin DSL для примера не требуются.

В **Failure Conditions** включите провал сборки при ненулевом коде процесса и задайте timeout 60 минут. Скрипт сначала выполняет `clean assembleDebug assembleDebugAndroidTest`, затем инструментальные тесты через CLI. `clean` убирает прежние отчёты до получения устройства. `pipefail` сохраняет ошибку сборки или CLI при записи логов через `tee`.

Тесты ограничены 20 минутами; очередь и запуск — 900 секундами, подключение — 60, освобождение — 180. При увеличении лимитов оставьте время в общем timeout для сборки, сбора logcat и завершения очистки.

## JUnit и артефакты при ошибке или отмене

В **General Settings → Artifact paths** добавьте:

```text
rdf-artifacts/%system.teamcity.build.id% => rdf
app/build/outputs/androidTest-results/connected => junit
app/build/reports/androidTests => android-report
```

В **Publish artifacts** выберите **Always, even if build stop command was issued**. Это [режим публикации TeamCity для ошибок и остановленных сборок](https://www.jetbrains.com/help/teamcity/configuring-general-settings.html). При потере агента или остановке во время самой загрузки публикация всё равно может не завершиться.

В **Build Features** добавьте встроенный **XML Report Processing**, тип **JUnit**, с правилом:

```text
+:app/build/outputs/androidTest-results/connected/**/*.xml
```

[XML Report Processing](https://www.jetbrains.com/help/teamcity/xml-report-processing.html) читает отчёты внутри checkout и показывает тесты в TeamCity; XML также сохраняется артефактом. Для другого модуля или варианта сборки обновите Gradle-задачи, правило JUnit и пути артефактов.

`ci/android-tests.sh` собирает logcat до освобождения и при обычном падении теста. В каталоге `rdf` будут `build.log`, `rdf-run.log`, `logcat.txt` и `logcat-errors.txt`. Если тесты не начались, JUnit и logcat могут отсутствовать; причина остаётся в журнале шага и имеющихся логах.

Для Maestro замените команду тестов по [примеру Maestro](maestro.md#сохранить-junit-и-logcat), сохраните его JUnit в `RDF_ARTIFACT_DIR` и поменяйте правило XML Report Processing на `+:rdf-artifacts/%system.teamcity.build.id%/maestro.xml`. Каталог уже включён в артефакты.

Для Appium скопируйте каталог [примера](../../examples/appium/) в `ci/appium`, выполните `npm ci --prefix ci/appium` до получения устройства, а внутри `ci/android-tests.sh` запустите `RDF_ARTIFACTS_DIR="$RDF_ARTIFACT_DIR" node ci/appium/run.mjs`. Укажите для публикации JUnit файл `appium.xml` из каталога артефактов сборки. [Настройка Appium](appium.md).

## Незавершённая очистка

Если CLI не смог подтвердить освобождение, `session.json` остаётся в `rdf-artifacts/<ID>/` и публикуется вместе с логами. Он содержит параметры запроса и ID, без API-токена и закрытого ключа. Скрипт не удаляет этот каталог после запуска. Сохраните файл до clean checkout или удаления workspace.

Для повторного освобождения скачайте состояние, передайте прежний адрес фермы и токен того же аккаунта через защищённое окружение, затем выполните:

```bash
export RDF_STATE_FILE="$PWD/session.json"
bash ci/rdf.sh release 180
```

Каталог `session.json.lock` после принудительного завершения можно удалять только после проверки, что прежний процесс больше не работает. Подробности — [в справочнике CLI](../api/README.md#если-запрос-или-освобождение-прервались).

При обычной отмене CLI обрабатывает сигналы и пытается освободить устройство. При потере процесса аренда перестаёт продлеваться, и сервер запрашивает очистку по её истечении. Слот остаётся занят до подтверждения агента фермы. Не перезапускайте общий ADB-сервер из задания.

## Если шаг не запускается

- **`RDF_CI_BUILD_ID must be numeric`:** задайте `env.RDF_CI_BUILD_ID` как `%system.teamcity.build.id%`, без дополнительного текста.
- **Не найдены инструменты:** проверьте PATH именно пользователя TeamCity-агента, а не своего интерактивного терминала.
- **Нет подключения ADB:** сопоставьте публичный ключ CI-аккаунта с закрытым ключом ADB-сервера этого агента.
- **Не видны тесты в интерфейсе:** проверьте путь JUnit, вариант Gradle и включение XML Report Processing; отсутствие отчёта до запуска тестов ожидаемо.
- **Нет артефактов после остановки:** проверьте режим публикации `Always, even if build stop command was issued` и доступность агента после отмены.

## Статус проверки

Настройки сверены с официальной документацией TeamCity. Запуск на живом TeamCity с Android-проектом здесь не подтверждён.
