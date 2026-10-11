import org.remotedevicefarm.DeviceFarmConfiguration

def call(Closure configure) {
    def configuration = new DeviceFarmConfiguration()
    configure.resolveStrategy = Closure.DELEGATE_ONLY
    configure.delegate = configuration
    configure()
    call(configuration.asMap())
}

def call(Map configuration) {
    def allowed = ['url', 'profile', 'adbKeyId', 'credentialsId', 'testScript', 'prepareScript',
                   'artifactsDirectory', 'junitReport', 'startTimeoutSeconds', 'testTimeoutSeconds'] as Set
    if (!allowed.containsAll(configuration.keySet())) error('deviceFarm: unknown configuration option')
    def defaults = [testScript: 'ci/android-tests.sh', prepareScript: '', artifactsDirectory: 'rdf-artifacts',
                    junitReport: 'app/build/outputs/androidTest-results/connected/**/*.xml',
                    startTimeoutSeconds: '900', testTimeoutSeconds: '1200']
    def settings = defaults + configuration
    for (name in ['url', 'profile', 'adbKeyId', 'credentialsId', 'testScript']) {
        if (!(settings[name] instanceof String) || !settings[name].trim()) error('deviceFarm: required configuration is missing')
    }
    if (settings.values().any { !(it instanceof String) || it.contains('\n') || it.contains('\r') }) {
        error('deviceFarm: configuration values must be single-line strings')
    }
    for (name in ['artifactsDirectory', 'testScript', 'prepareScript', 'junitReport']) {
        def value = settings[name]
        if (value && (value.startsWith('/') || value.contains('\\') || value.split('/').contains('..'))) {
            error('deviceFarm: file paths must stay inside the workspace')
        }
    }
    if (!(settings.artifactsDirectory ==~ '[A-Za-z0-9_./-]+') || settings.artifactsDirectory == '.') {
        error('deviceFarm: invalid artifacts directory')
    }
    for (name in ['startTimeoutSeconds', 'testTimeoutSeconds']) {
        if (!(settings[name] ==~ /[1-9][0-9]{0,4}/) || settings[name].toInteger() > 86400) {
            error('deviceFarm: timeout must be 1-86400 seconds')
        }
    }
    if (!isUnix()) error('deviceFarm: a Linux agent is required')
    def runDirectory = settings.artifactsDirectory + '/' + UUID.randomUUID().toString()
    def environment = [
        "RDF_URL=${settings.url}", "RDF_PROFILE=${settings.profile}", "RDF_ADB_KEY_ID=${settings.adbKeyId}",
        "RDF_TEST_SCRIPT=${settings.testScript}", "RDF_PREPARE_SCRIPT=${settings.prepareScript}",
        "RDF_ARTIFACT_DIR=${runDirectory}", "RDF_STATE_FILE=${runDirectory}/session.json",
        "RDF_START_TIMEOUT_SECONDS=${settings.startTimeoutSeconds}", "RDF_TEST_TIMEOUT_SECONDS=${settings.testTimeoutSeconds}",
        "RDF_LABEL=jenkins-${env.BUILD_NUMBER ?: 'build'}", 'RDF_TOKEN_VARIABLE=RDF_TOKEN',
        "RDF_CLI_SCRIPT=${runDirectory}/tools/rdf.sh", "RDF_RUNNER_SCRIPT=${runDirectory}/tools/run-tests.sh"
    ]
    def failure = null
    withEnv(environment) {
        try {
            sh(script: '''#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
[ -f "$RDF_TEST_SCRIPT" ]
mkdir -p -- "$RDF_ARTIFACT_DIR/tools"
if [ -n "$RDF_PREPARE_SCRIPT" ]; then env -u RDF_TOKEN bash "$RDF_PREPARE_SCRIPT"; fi
''')
            writeFile(file: runDirectory + '/tools/rdf.sh', text: libraryResource('rdf/rdf.sh'))
            writeFile(file: runDirectory + '/tools/run-tests.sh', text: libraryResource('rdf/run-tests.sh'))
            withCredentials([string(credentialsId: settings.credentialsId, variable: 'RDF_TOKEN')]) {
                sh(script: '''#!/usr/bin/env bash
set +x
set -euo pipefail
bash "$RDF_RUNNER_SCRIPT" -- bash "$RDF_TEST_SCRIPT"
''')
            }
        } catch (problem) {
            failure = problem
        } finally {
            try {
                junit(testResults: settings.junitReport, allowEmptyResults: true)
            } catch (problem) {
                echo('deviceFarm: JUnit publication failed')
                if (failure == null) failure = problem
            }
            try {
                archiveArtifacts(artifacts: runDirectory + '/**,' + settings.junitReport, allowEmptyArchive: true)
            } catch (problem) {
                echo('deviceFarm: artifact publication failed')
                if (failure == null) failure = problem
            }
        }
    }
    if (failure != null) throw failure
    return runDirectory
}
