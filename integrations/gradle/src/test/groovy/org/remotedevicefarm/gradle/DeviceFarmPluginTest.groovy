package org.remotedevicefarm.gradle

import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import static org.junit.Assert.*

class DeviceFarmPluginTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder()

    private Map fixture(Map extra = [:], String configuration = '') {
        File directory = temporary.newFolder()
        File bin = new File(directory, 'bin'); bin.mkdirs()
        File repository = new File(System.getProperty('rdf.repository'))
        File backend = new File(bin, 'backend.cjs')
        backend.bytes = new File(repository, 'scripts/test/support/ci-backend.cjs').bytes
        for (String tool : ['curl', 'adb']) {
            File file = new File(bin, tool)
            file.text = '#!/usr/bin/env bash\nFAKE_TOOL=' + tool + ' exec node "$(dirname "$0")/backend.cjs" "$@"\n'
            file.setExecutable(true)
        }
        new File(directory, 'settings.gradle').text = "rootProject.name = 'fixture'\n"
        new File(directory, 'gradle.properties').text = 'org.gradle.jvmargs=-Xmx384m -XX:MaxMetaspaceSize=256m\norg.gradle.workers.max=1\n'
        String bash = System.getenv('RDF_TEST_BASH') ?: (System.getProperty('os.name').startsWith('Windows') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash')
        new File(directory, 'build.gradle').text = """
plugins { id 'io.github.kavabunga6.device-farm' }
deviceFarm {
    url = 'https://farm.example.com'
    profile = 'android-30'
    adbKeyId = '33333333-3333-4333-8333-333333333333'
    prepareTasks = []
    testCommand = ['bash', 'tests.sh', 'argument with spaces']
    bashExecutable = '${bash.replace('\\', '/').replace("'", "\\'")}'
    startTimeoutSeconds = 10
    ${configuration}
}
"""
        new File(directory, 'tests.sh').text = '''#!/usr/bin/env bash
set -eu
[ -z "${RDF_TOKEN:-}" ] && [ -z "${TEST_CI_TOKEN:-}" ] || exit 88
[ "$ANDROID_SERIAL" = fixture:15555 ]
[ "$1" = 'argument with spaces' ]
echo 'fixture-tests'
exit "${TEST_EXIT:-0}"
'''
        Map environment = new LinkedHashMap(System.getenv())
        String oldPath = environment.find { it.key.equalsIgnoreCase('path') }?.value ?: ''
        environment.keySet().findAll { it.equalsIgnoreCase('path') || (it.startsWith('RDF_') && !it.startsWith('RDF_TEST_')) }.each { environment.remove(it) }
        List path = [bin.absolutePath]
        if (System.getProperty('os.name').startsWith('Windows')) path << 'C:/Program Files/Git/usr/bin'
        if (System.getenv('RDF_TEST_JQ_DIR')) path << System.getenv('RDF_TEST_JQ_DIR')
        path << oldPath
        String shellBin = bin.absolutePath.replace('\\', '/')
        if (shellBin ==~ /^[A-Za-z]:.*/) shellBin = '/' + shellBin.substring(0, 1).toLowerCase() + shellBin.substring(2)
        File startup = new File(directory, 'bash-env.sh')
        startup.text = 'export PATH="' + shellBin + ':$PATH"\n'
        environment.BASH_ENV = startup.absolutePath
        environment.putAll([
            PATH: path.join(File.pathSeparator),
            RDF_TOKEN: 'fixture-token', TRACE: new File(directory, 'trace').absolutePath,
            STOPPED_FILE: new File(directory, 'stopped').absolutePath,
            RDF_POLL_SECONDS: '1', RDF_HTTP_TIMEOUT_SECONDS: '2', RDF_RELEASE_TIMEOUT_SECONDS: '2',
        ] + extra)
        [directory: directory, environment: environment]
    }

    private GradleRunner runner(Map fixture, List arguments = []) {
        GradleRunner.create().withProjectDir(fixture.directory).withPluginClasspath()
            .withArguments(['deviceFarmTest', '--stacktrace', '--max-workers=1'] + arguments)
            .withEnvironment(fixture.environment)
    }

    private List<File> runs(Map fixture) {
        new File(fixture.directory, 'build/device-farm').listFiles()?.findAll { it.isDirectory() } ?: []
    }

    @Test void realCliRunsTestsAndConfirmsCleanupWithoutLeakingCredentials() {
        def f = fixture()
        def result = runner(f).build()
        assertEquals(TaskOutcome.SUCCESS, result.task(':deviceFarmTest').outcome)
        File artifacts = runs(f).first()
        assertEquals('fixture-tests\n', new File(artifacts, 'test.log').text)
        assertEquals('fixture-logcat\n', new File(artifacts, 'logcat.txt').text)
        assertFalse(new File(artifacts, 'session.json').exists())
        assertFalse(result.output.contains('fixture-token'))
        assertTrue(new File(f.directory, 'trace').text.contains('"method":"DELETE","path":"/api/sessions/'))
    }

    @Test void failedTestsOrUnconfirmedCleanupFailTheBuild() {
        for (Map extra : [[TEST_EXIT: '7'], [CLEANUP_PENDING: '1']]) {
            def f = fixture(extra)
            def result = runner(f).buildAndFail()
            assertTrue(result.output.contains('tests or cleanup failed'))
            assertTrue(new File(f.directory, 'trace').text.contains('"method":"DELETE","path":"/api/sessions/'))
            assertEquals(extra.containsKey('CLEANUP_PENDING'), new File(runs(f).first(), 'session.json').exists())
        }
    }

    @Test void configurationCacheReusesConfigurationButAlwaysRentsANewDevice() {
        def f = fixture()
        runner(f, ['--configuration-cache']).build()
        new File(f.directory, 'stopped').delete()
        def result = runner(f, ['--configuration-cache']).build()
        assertTrue(result.output.contains('Reusing configuration cache'))
        assertEquals(TaskOutcome.SUCCESS, result.task(':deviceFarmTest').outcome)
        assertEquals(2, runs(f).size())
    }

    @Test void customTokenVariableIsNotPassedToTests() {
        def f = fixture([RDF_TOKEN: '', TEST_CI_TOKEN: 'fixture-token'], "tokenEnvironmentVariable = 'TEST_CI_TOKEN'")
        assertEquals(TaskOutcome.SUCCESS, runner(f).build().task(':deviceFarmTest').outcome)
    }

    @Test void invalidConfigurationOrMissingTokenCannotAllocate() {
        for (Map value : [
            [extra: [RDF_TOKEN: ''], config: ''],
            [extra: [:], config: "testTimeoutSeconds = 0"],
            [extra: [:], config: "url = 'https://user:password@farm.example.com'"]
        ]) {
            def f = fixture(value.extra, value.config)
            runner(f).buildAndFail()
            assertFalse(new File(f.directory, 'trace').exists())
        }
    }

    @Test void buildTasksAndRealNestedGradleWorkWithAnIncludedPluginBuild() {
        def f = fixture([:], "prepareTasks = ['prepareApk']; testCommand = ['./gradlew', 'verifyOnDevice', '--no-daemon']; testTimeoutSeconds = 60")
        File repository = new File(System.getProperty('rdf.repository'))
        File included = new File(f.directory, 'farm/integrations/gradle')
        included.mkdirs()
        for (String path : ['build.gradle', 'settings.gradle', 'gradle.properties']) {
            new File(included, path).bytes = new File(repository, 'integrations/gradle/' + path).bytes
        }
        File sources = new File(repository, 'integrations/gradle/src/main')
        sources.eachFileRecurse { File source ->
            if (source.isFile()) {
                File destination = new File(included, 'src/main/' + sources.toPath().relativize(source.toPath()).toString())
                destination.parentFile.mkdirs()
                destination.bytes = source.bytes
            }
        }
        for (String path : ['LICENSE', 'scripts/rdf.sh', 'integrations/common/run-tests.sh']) {
            File destination = new File(f.directory, 'farm/' + path)
            destination.parentFile.mkdirs()
            destination.bytes = new File(repository, path).bytes
        }
        for (String path : ['gradlew', 'gradle/wrapper/gradle-wrapper.properties', 'gradle/wrapper/gradle-wrapper.jar']) {
            File destination = new File(f.directory, path)
            destination.parentFile.mkdirs()
            destination.bytes = new File(repository, 'integrations/gradle/' + path).bytes
            destination.setExecutable(true)
        }
        new File(f.directory, 'settings.gradle').text = "pluginManagement { includeBuild('farm/integrations/gradle') }\nrootProject.name = 'nested-fixture'\n"
        new File(f.directory, 'build.gradle') << """
def traceFile = layout.projectDirectory.file('trace').asFile
tasks.register('prepareApk') { doLast { traceFile.append('prepared\\n') } }
tasks.register('verifyOnDevice') {
    doLast {
        assert System.getenv('RDF_TOKEN') == null
        assert System.getenv('ANDROID_SERIAL') == 'fixture:15555'
        assert gradle.startParameter.projectCacheDir != null
        println 'real-nested-gradle-test'
    }
}
"""
        def result = GradleRunner.create().withProjectDir(f.directory)
            .withArguments('deviceFarmTest', '--stacktrace', '--max-workers=1', '--offline')
            .withEnvironment(f.environment).build()
        assertEquals(TaskOutcome.SUCCESS, result.task(':deviceFarmTest').outcome)
        assertTrue(new File(f.directory, 'trace').text.startsWith('prepared\n'))
        assertTrue(new File(runs(f).first(), 'test.log').text.contains('real-nested-gradle-test'))
        assertFalse(new File(runs(f).first(), 'session.json').exists())
    }

    @Test void publishedMavenMarkerLoadsThePackagedPluginFromKotlinDsl() {
        def f = fixture()
        new File(f.directory, 'build.gradle').delete()
        String bash = System.getenv('RDF_TEST_BASH') ?: (System.getProperty('os.name').startsWith('Windows') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash')
        String repositoryUrl = new File(System.getProperty('rdf.repository'), 'integrations/gradle/build/repository').toURI().toString()
        new File(f.directory, 'settings.gradle').text = "pluginManagement { repositories { maven { url = '${repositoryUrl}' } } }\nrootProject.name = 'published-fixture'\n"
        new File(f.directory, 'build.gradle.kts').text = """
plugins { id("io.github.kavabunga6.device-farm") version "0.1.0" }
deviceFarm {
    url.set("https://farm.example.com")
    profile.set("android-30")
    adbKeyId.set("33333333-3333-4333-8333-333333333333")
    prepareTasks.set(emptyList())
    testCommand.set(listOf("bash", "tests.sh", "argument with spaces"))
    bashExecutable.set("${bash.replace('\\', '/')}")
    startTimeoutSeconds.set(10)
}
"""
        def result = GradleRunner.create().withProjectDir(f.directory)
            .withArguments('deviceFarmTest', '--stacktrace', '--max-workers=1')
            .withEnvironment(f.environment).build()
        assertEquals(TaskOutcome.SUCCESS, result.task(':deviceFarmTest').outcome)
        assertEquals('fixture-logcat\n', new File(runs(f).first(), 'logcat.txt').text)
        assertFalse(new File(runs(f).first(), 'session.json').exists())
    }
}
