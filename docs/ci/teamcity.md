# TeamCity build runner

[CI integrations](README.md) · [Worker requirements](native-packages.md)

The installable plugin adds a **Remote Device Farm** build step. Its server part provides configuration and validation; the agent part bundles the CLI, runs tests and retries cleanup after process termination. JUnit and run artifacts are published through TeamCity service messages.

## Build and install

Requires JDK 17 and TeamCity 2024.12 or newer:

```bash
integrations/gradle/gradlew -p integrations/teamcity check assemble
```

Install `integrations/teamcity/build/distributions/remote-device-farm-teamcity-0.1.0.zip` in **Administration → Plugins**. Apply the plugin/restart procedure required by the TeamCity installation and allow agents to receive the agent plugin. The ZIP is also produced by the repository's CI package job.

## Configure a build

1. Select a Linux agent with the [required tools](native-packages.md).
2. Add `env.RDF_TOKEN` as a **Password** parameter. The runner stores the variable's name, not its token value.
3. Provision the matching private ADB key and optional TLS certificate as protected agent files.
4. Add **Remote Device Farm** and set the HTTPS URL, profile, public key UUID and private key file path.
5. Set `prepareScript=ci/build.sh` and `testScript=ci/android-tests.sh`. Customize the JUnit glob for the project.

Kotlin DSL can use the registered runner type:

```kotlin
steps {
    step {
        name = "Android tests"
        type = "remote-device-farm"
        param("url", "https://farm.example.com")
        param("profile", "android-30")
        param("adbKeyId", "33333333-3333-4333-8333-333333333333")
        param("tokenVariable", "RDF_TOKEN")
        param("adbKeyFile", "%env.RDF_ADB_KEY_FILE%")
        param("prepareScript", "ci/build.sh")
        param("testScript", "ci/android-tests.sh")
    }
}
```

The form uses standard TeamCity controls with English/Russian labels. Cancellation requests termination of the owned process tree, followed by bounded recovery. An interrupted build remains interrupted; cleanup failure cannot produce a successful step.

**Verification:** compiled against the official TeamCity 2024.12 SDK; configuration, environment, command and interruption contracts tested. Plugin installation, form rendering in TeamCity themes, live JUnit publication, cancellation and agent loss are **Not tested**.

The older [Command Line example](../../examples/teamcity/) remains a compatibility example. New configurations should use the build runner.
