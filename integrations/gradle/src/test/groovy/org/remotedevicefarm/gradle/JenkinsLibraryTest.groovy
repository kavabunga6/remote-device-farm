package org.remotedevicefarm.gradle

import org.junit.Test
import static org.junit.Assert.*

class JenkinsLibraryTest {
    private Map fixture(Map flags = [:]) {
        File repository = new File(System.getProperty('rdf.repository'))
        GroovyClassLoader loader = new GroovyClassLoader(getClass().classLoader)
        loader.parseClass(new File(repository, 'src/org/remotedevicefarm/DeviceFarmConfiguration.groovy'))
        Map environment = [BUILD_NUMBER: '42']
        List events = []
        int credentials = 0
        def binding = new Binding([
            env: environment,
            error: { String message -> throw new IllegalArgumentException(message) },
            echo: { String message -> events << ['echo', message] },
            isUnix: { -> true },
            withEnv: { List values, Closure body ->
                def previous = new LinkedHashMap(environment)
                values.each { String entry -> def pair = entry.split('=', 2); environment[pair[0]] = pair[1] }
                try { body() } finally { environment.clear(); environment.putAll(previous) }
            },
            string: { Map value -> value },
            withCredentials: { List values, Closure body ->
                events << ['credentials', values[0].credentialsId]
                credentials++
                try { body() } finally { credentials-- }
            },
            sh: { Map value ->
                if (value.script.contains('bash "$RDF_RUNNER_SCRIPT"')) {
                    assertEquals(1, credentials)
                    events << ['test', environment.RDF_ARTIFACT_DIR]
                    if (flags.testFailure) throw new IllegalStateException('test failure')
                } else {
                    assertEquals(0, credentials)
                    events << ['prepare']
                    if (flags.prepareFailure) throw new IllegalStateException('prepare failure')
                }
            },
            writeFile: { Map value -> events << ['write', value.file] },
            libraryResource: { String name -> new File(repository, 'resources/' + name).text },
            junit: { Map value -> events << ['junit']; if (flags.junitFailure) throw new IllegalStateException('junit failure') },
            archiveArtifacts: { Map value -> events << ['archive']; if (flags.archiveFailure) throw new IllegalStateException('archive failure') }
        ])
        def library = new GroovyShell(loader, binding).parse(new File(repository, 'vars/deviceFarm.groovy'))
        [library: library, events: events, environment: environment]
    }

    private Map configuration() {
        [url: 'https://farm.example.com', profile: 'android-30',
         adbKeyId: '33333333-3333-4333-8333-333333333333', credentialsId: 'rdf-api-token']
    }

    @Test void publishesAfterSuccessfulRunAndUsesCredentialsOnlyForTests() {
        def f = fixture()
        String directory = f.library.call(configuration())
        assertTrue(directory.startsWith('rdf-artifacts/'))
        assertEquals(['prepare', 'write', 'write', 'credentials', 'test', 'junit', 'archive'], f.events.collect { it[0] })
        assertEquals([BUILD_NUMBER: '42'], f.environment)
        assertNotEquals(directory, f.library.call(configuration()))
    }
    @Test void configurationClosureUsesTheSamePipelineStep() {
        def f = fixture()
        f.library.call {
            url = 'https://farm.example.com'
            profile = 'android-30'
            adbKeyId = '33333333-3333-4333-8333-333333333333'
            credentialsId = 'rdf-api-token'
        }
        assertTrue(f.events.any { it[0] == 'test' })
    }
    @Test void failuresStillPublishAndKeepTheOriginalError() {
        for (String type : ['testFailure', 'prepareFailure']) {
            def f = fixture([(type): true, archiveFailure: true])
            try { f.library.call(configuration()); fail('must fail') }
            catch (IllegalStateException problem) { assertEquals(type == 'testFailure' ? 'test failure' : 'prepare failure', problem.message) }
            assertEquals(['junit', 'archive'], f.events.findAll { it[0] in ['junit', 'archive'] }.collect { it[0] })
        }
    }
    @Test void publicationFailureCannotReportSuccess() {
        def f = fixture([junitFailure: true])
        try { f.library.call(configuration()); fail('must fail') }
        catch (IllegalStateException problem) { assertEquals('junit failure', problem.message) }
        assertTrue(f.events.any { it[0] == 'archive' })
    }
    @Test void invalidConfigurationCannotExecuteShellOrBindCredentials() {
        for (Map invalid : [[credentialsId: ''], [testScript: '../secrets.sh'], [startTimeoutSeconds: '0'], [url: 'x\ny'], [unknown: 'x']]) {
            def f = fixture()
            try { f.library.call(configuration() + invalid); fail('must fail') }
            catch (IllegalArgumentException expected) { }
            assertTrue(f.events.empty)
        }
    }
}
