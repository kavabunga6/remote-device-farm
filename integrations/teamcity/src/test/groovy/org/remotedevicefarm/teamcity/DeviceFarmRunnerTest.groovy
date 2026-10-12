package org.remotedevicefarm.teamcity

import org.junit.Test
import static org.junit.Assert.*
import jetbrains.buildServer.agent.*
import jetbrains.buildServer.agent.runner.*
import jetbrains.buildServer.serverSide.*
import jetbrains.buildServer.web.openapi.PluginDescriptor
import java.nio.file.Files

class DeviceFarmRunnerTest {
    Map settings() { [url:'https://farm.example.com',profile:'android-30',adbKeyId:'33333333-3333-4333-8333-333333333333'] }
    @Test void validatesBeforeAllocationAndReportsTheField() {
        for (Map value : [[url:'http://farm.example.com'],[testScript:'../x.sh'],[tokenVariable:'invalid token'],[startTimeoutSeconds:'0'],[adbKeyId:'invalid'],[artifactsDirectory:'.']]) {
            try { RunnerSettings.validate(settings()+value);fail('must reject') }
            catch (RunnerSettings.InputException problem) { assertEquals(value.keySet().first(),problem.field) }
        }
        assertEquals('RDF_TOKEN',RunnerSettings.validate(settings()).tokenVariable)
    }
    @Test void keepsSecretOnlyInEnvironmentAndEscapesServiceMessages() {
        def options=RunnerSettings.validate(settings())
        def env=RunnerSettings.environment(options,[RDF_TOKEN:'fixture-token'],new File('/tmp/fixture/run').toPath(),new File('/tmp/fixture/tools').toPath(),'fixture')
        assertEquals('fixture-token',env.RDF_TOKEN)
        assertEquals('fixture',env.RDF_LABEL)
        assertEquals("x|'|[|]||",RunnerSettings.escape("x'[]|"))
    }
    @Test void factorySelectsOnlyLinuxAgents() {
        def factory=new DeviceFarmRunnerFactory()
        assertEquals(RunnerSettings.TYPE,factory.type)
        String previous=System.getProperty('os.name')
        try {
            for (def value : [[os:'Linux',unix:true,mac:false,expected:true],[os:'FreeBSD',unix:true,mac:false,expected:false],[os:'Mac OS X',unix:true,mac:true,expected:false],[os:'Windows',unix:false,mac:false,expected:false]]) {
                System.setProperty('os.name',value.os)
                def info=[isUnix:{value.unix},isMac:{value.mac}] as BuildAgentSystemInfo
                def conf=[getSystemInfo:{info}] as BuildAgentConfiguration
                assertEquals(value.expected,factory.canRun(conf))
            }
        }finally{System.setProperty('os.name',previous)}
    }
    @Test void controllerRegistersRunnerWithValidationAndNoTokenValueField() {
        def registry=[registerRunType:{RunType type -> assertEquals(RunnerSettings.TYPE,type.type)}] as RunTypeRegistry
        def descriptor=[getPluginResourcesPath:{String file -> '/plugins/remote-device-farm/'+file}] as PluginDescriptor
        def type=new DeviceFarmRunType(registry,descriptor)
        assertTrue(type.editRunnerParamsJspFilePath.endsWith('editRunner.jsp'))
        assertFalse(type.defaultRunnerProperties.containsKey('token'))
        assertFalse(type.runnerPropertiesProcessor.process(settings()).size()>0)
        assertEquals('testScript',type.runnerPropertiesProcessor.process(settings()+[testScript:'../invalid']).first().propertyName)
    }
    @Test void sdkCommandContainsNoCredentialAndCancellationCannotTurnGreen() {
        def directory=Files.createTempDirectory('rdf-teamcity-unit-').toFile()
        try {
            def parameters=[getEnvironmentVariables:{[RDF_TOKEN:'fixture-token']},getSystemProperties:{[:]},getAllParameters:{[:]}] as BuildParametersMap
            def flow=[startFlow:{},finishFlow:{},getFlowId:{'fixture'}] as FlowLogger
            def logger=[getFlowLogger:{String id -> flow}] as BuildProgressLogger
            def build=[getBuildLogger:{logger},getCheckoutDirectory:{directory},getWorkingDirectory:{directory},getBuildId:{42L}] as AgentRunningBuild
            def context=[getBuild:{build},getWorkingDirectory:{directory},getRunnerParameters:{settings()},getBuildParameters:{parameters},getId:{'runner-1'},getRunType:{RunnerSettings.TYPE}] as BuildRunnerContext
            def service=new DeviceFarmBuildService();service.initialize(build,context)
            def command=service.makeProgramCommandLine()
            assertEquals('bash',command.executablePath)
            assertEquals('run',command.arguments.last())
            assertFalse(command.arguments.join(' ').contains('fixture-token'))
            assertEquals('fixture-token',command.environment.RDF_TOKEN)
            assertEquals(BuildFinishedStatus.FINISHED_FAILED,service.getRunResult(7))
            assertEquals(TerminationAction.KILL_PROCESS_TREE,service.interrupt())
            assertEquals(BuildFinishedStatus.INTERRUPTED,service.getRunResult(0))
        } finally { directory.deleteDir() }
    }
}
