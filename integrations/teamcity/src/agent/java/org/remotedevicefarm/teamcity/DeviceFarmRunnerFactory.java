package org.remotedevicefarm.teamcity;

import jetbrains.buildServer.agent.*;
import jetbrains.buildServer.agent.runner.*;

public final class DeviceFarmRunnerFactory implements CommandLineBuildServiceFactory,AgentBuildRunnerInfo {
    @Override public CommandLineBuildService createService(){return new DeviceFarmBuildService();}
    @Override public AgentBuildRunnerInfo getBuildRunnerInfo(){return this;}
    @Override public String getType(){return RunnerSettings.TYPE;}
    @Override public boolean canRun(BuildAgentConfiguration configuration){return "Linux".equalsIgnoreCase(System.getProperty("os.name"))&&configuration.getSystemInfo().isUnix()&&!configuration.getSystemInfo().isMac();}
}
