# Gradle-плагин

[Все интеграции](README.md) · [Исходники плагина](../../integrations/gradle/)

Плагин `io.github.kavabunga6.device-farm` добавляет задачу `deviceFarmTest`: подготовка APK, очередь устройства, подключение ADB, команда тестов, logcat, скриншот и освобождение сессии. CLI включён в JAR. Требуются JDK 17+, Gradle 8.14.5+ и подготовленное Linux-окружение с Bash, curl, jq, GNU timeout, tee и ADB.

## Подключить из исходников

Закрепите копию этого репозитория на выбранном коммите. В `settings.gradle` Android-проекта добавьте путь к каталогу плагина:

```groovy
pluginManagement {
    includeBuild('../remote-device-farm/integrations/gradle')
}
```

В корневом `build.gradle`:

```groovy
plugins {
    id 'io.github.kavabunga6.device-farm'
}

deviceFarm {
    url = 'https://farm.example.com'
    profile = 'android-30'
    adbKeyId = '33333333-3333-4333-8333-333333333333'
    prepareTasks = [':app:assembleDebug', ':app:assembleDebugAndroidTest']
    testCommand = ['./gradlew', ':app:connectedDebugAndroidTest', '--no-daemon']
}
```

Для Kotlin DSL используйте те же свойства:

```kotlin
// settings.gradle.kts
pluginManagement {
    includeBuild("../remote-device-farm/integrations/gradle")
}
```

```kotlin
// build.gradle.kts
plugins { id("io.github.kavabunga6.device-farm") }
deviceFarm {
    url.set("https://farm.example.com")
    profile.set("android-30")
    adbKeyId.set("33333333-3333-4333-8333-333333333333")
    prepareTasks.set(listOf(":app:assembleDebug", ":app:assembleDebugAndroidTest"))
    testCommand.set(listOf("./gradlew", ":app:connectedDebugAndroidTest", "--no-daemon"))
}
```

Настройте закрытый ADB-ключ и экспортируйте API-токен через секреты CI:

```bash
./gradlew deviceFarmTest --no-daemon
```

Токен читается во время выполнения из `RDF_TOKEN`. Он не задаётся через Gradle DSL, аргументы команд или свойства сборки и не передаётся тестовому процессу. Для другой секретной переменной задайте `tokenEnvironmentVariable = 'ANDROID_TEST_API_TOKEN'`.

## Настройки

| Свойство | Значение |
| --- | --- |
| `url`, `profile`, `adbKeyId` | Обязательные адрес сервиса, профиль и публичный ключ |
| `prepareTasks` | Задачи сборки до аренды; по умолчанию две задачи `:app:assembleDebug` и `:app:assembleDebugAndroidTest` |
| `testCommand` | Список аргументов; по умолчанию `./gradlew :app:connectedDebugAndroidTest --no-daemon` |
| `tokenEnvironmentVariable` | `RDF_TOKEN` |
| `bashExecutable` | `bash` |
| `artifactsDirectory` | `build/device-farm`; каждый запуск получает отдельный подкаталог |
| `startTimeoutSeconds`, `testTimeoutSeconds` | `900`, `1200` |

Плагин применяется в корневом проекте. Команда тестов работает из его каталога. Замените `app` и `Debug` под свой модуль и вариант сборки. Для Maestro или Appium задайте свою команду и список задач подготовки; команда получает `ANDROID_SERIAL`, `RDF_SESSION` и `RDF_ARTIFACT_DIR`.

Прямой вложенный запуск `gradlew` или `gradle` получает отдельный `--project-cache-dir`, чтобы не ждать блокировку внешней сборки. Если запускаете Gradle через собственный shell-скрипт, задайте отдельный project cache в этом скрипте. Команда тестов не должна повторно вызывать `deviceFarmTest`.

Параметры `RDF_DISK_GB`, `RDF_SD_CARD_MB` и `RDF_EMULATOR_PARAMS` читаются из окружения по [общему контракту CLI](../api/README.md#память-устройства-sd-карта-и-аргументы-запуска).

## Артефакты и ошибки

В каталоге запуска сохраняются `test.log`, `logcat.txt`, `screenshot.png` и диагностика сбора. JUnit и HTML-отчёты создаёт выбранный тестовый инструмент; настройте их публикацию в CI. Подготовка APK не занимает устройство. Задача всегда выполняется заново и не использует Gradle build cache для результатов тестов.

При ошибке теста или неподтверждённой очистке задача падает. Если остался `session.json`, сохраните каталог запуска и повторите освобождение через извлечённый `tools/rdf.sh` с тем же аккаунтом. [Восстановление](../api/README.md#если-запрос-или-освобождение-прервались). При потере процесса работает серверный срок аренды.

## Собрать и установить пакет

Из каталога `integrations/gradle`:

```bash
./gradlew check publishAllPublicationsToLocalBuildRepository
```

JAR, исходники, POM и plugin marker находятся в `build/repository/`. Этот Maven-репозиторий можно разместить во внутреннем хранилище компании. Затем подключите его через `pluginManagement.repositories` и используйте ID плагина с версией `0.1.0`. В Gradle Plugin Portal пакет пока не опубликован.

## Проверки

Проверки выполнены на Gradle 8.14.5 и 9.3.1. Gradle TestKit проверяет установку собранного Maven-пакета, Groovy/Kotlin DSL, применение плагина, выполнение с общим CLI, ошибки тестов и очистки, изоляцию токена, отдельные каталоги и повторное выполнение с configuration cache. Groovy-тесты Jenkins запускаются из этого же проекта. Android instrumentation с реальным AGP/SDK, живое устройство и публикация во внешний Maven/Plugin Portal: **Not tested**.
