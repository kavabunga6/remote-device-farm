package org.remotedevicefarm.teamcity;

import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.*;
import java.util.concurrent.TimeUnit;
import jetbrains.buildServer.RunBuildException;
import jetbrains.buildServer.agent.*;
import jetbrains.buildServer.agent.runner.*;

public final class DeviceFarmBuildService extends BuildServiceAdapter {
    private Map<String,String> options,environment;
    private Path checkout,run,tools;
    private boolean cleanupFailed;
    private volatile boolean interrupted;
    @Override public void afterInitialized() throws RunBuildException {
        try {
            options=RunnerSettings.validate(getRunnerParameters());checkout=getCheckoutDirectory().toPath().toRealPath();
            Path base=checkout.resolve(options.get("artifactsDirectory")).normalize();
            Path ancestor=base;while(!Files.exists(ancestor))ancestor=ancestor.getParent();
            if(base.equals(checkout)||!ancestor.toRealPath().startsWith(checkout))throw new IOException("Artifacts directory leaves checkout");
            Files.createDirectories(base);
            if (!base.toRealPath().startsWith(checkout)) throw new IOException("Artifacts directory leaves checkout");
            run=base.resolve(UUID.randomUUID().toString());Files.createDirectory(run);
            if(Files.getFileStore(run).supportsFileAttributeView("posix"))Files.setPosixFilePermissions(run,PosixFilePermissions.fromString("rwx------"));tools=run.resolve("tools");Files.createDirectory(tools);
            for (String name:List.of("rdf.sh","run-tests.sh","managed-runtime.sh","managed-cleanup.sh","native-entry.sh")) {
                try(InputStream stream=getClass().getResourceAsStream("/rdf/"+name)) {
                    if(stream==null) throw new IOException("Embedded CLI resource is missing");Files.copy(stream,tools.resolve(name));
                }
            }
            environment=RunnerSettings.environment(options,getEnvironmentVariables(),run,tools,"teamcity-"+getBuild().getBuildId()+"-"+getRunnerContext().getId());
            String timeout=environment.getOrDefault("RDF_RELEASE_TIMEOUT_SECONDS","180");
            if(!timeout.matches("[1-9][0-9]{0,4}")||Long.parseLong(timeout)>86400)throw new IllegalArgumentException("Invalid release timeout");
        } catch(IOException|IllegalArgumentException failure){throw new RunBuildException("Device Farm runner configuration is invalid",failure);}
    }
    @Override public ProgramCommandLine makeProgramCommandLine() throws RunBuildException {
        return new SimpleProgramCommandLine(environment,checkout.toString(),"bash",List.of(tools.resolve("native-entry.sh").toString(),"run"),"Device Farm managed Android tests");
    }
    @Override public boolean isCommandLineLoggingEnabled(){return false;}
    @Override public TerminationAction interrupt(){interrupted=true;return TerminationAction.KILL_PROCESS_TREE;}
    @Override public void afterProcessFinished() throws RunBuildException {
        if(environment==null)return;
        Path log=run.resolve("controller-cleanup.log");
        Process process=null;
        try {
            ProcessBuilder builder=new ProcessBuilder("bash",tools.resolve("native-entry.sh").toString(),"recover");
            builder.directory(checkout.toFile());builder.environment().clear();builder.environment().putAll(environment);
            builder.redirectErrorStream(true);builder.redirectOutput(log.toFile());
            process=builder.start();
            if(!process.waitFor(Long.parseLong(environment.getOrDefault("RDF_RELEASE_TIMEOUT_SECONDS","180"))+40,TimeUnit.SECONDS)){stop(process);cleanupFailed=true;}
            else cleanupFailed=process.exitValue()!=0;
        }catch(IOException failure){cleanupFailed=true;}
        catch(InterruptedException failure){if(process!=null)stop(process);Thread.currentThread().interrupt();cleanupFailed=true;}
        finally {
            String relative=checkout.relativize(run).toString().replace(File.separatorChar,'/');
            getLogger().message("##teamcity[publishArtifacts '"+RunnerSettings.escape(relative+" => rdf/"+run.getFileName())+"']");
            getLogger().message("##teamcity[importData type='junit' path='"+RunnerSettings.escape(options.get("junitReport"))+"']");
        }
        if(cleanupFailed)getLogger().warning("Device cleanup remains pending; retain the run directory");
    }
    private static void stop(Process process){
        var children=process.descendants().toList();children.forEach(ProcessHandle::destroy);process.destroy();
        try{process.waitFor(5,TimeUnit.SECONDS);}
        catch(InterruptedException ignored){Thread.currentThread().interrupt();}
        finally{children.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly);if(process.isAlive())process.destroyForcibly();}
    }
    @Override public BuildFinishedStatus getRunResult(int code) {
        if(interrupted)return BuildFinishedStatus.INTERRUPTED;
        return code==0&&!cleanupFailed?BuildFinishedStatus.FINISHED_SUCCESS:BuildFinishedStatus.FINISHED_FAILED;
    }
}
