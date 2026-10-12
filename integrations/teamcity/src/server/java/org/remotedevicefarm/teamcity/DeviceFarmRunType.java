package org.remotedevicefarm.teamcity;

import java.util.*;
import jetbrains.buildServer.serverSide.*;
import jetbrains.buildServer.web.openapi.PluginDescriptor;

public final class DeviceFarmRunType extends RunType {
    private final PluginDescriptor descriptor;
    public DeviceFarmRunType(RunTypeRegistry registry,PluginDescriptor descriptor) {this.descriptor=descriptor;registry.registerRunType(this);}
    @Override public String getType(){return RunnerSettings.TYPE;}
    @Override public String getDisplayName(){return "Remote Device Farm";}
    @Override public String getDescription(){return "Android tests with queued allocation, protected credentials and confirmed cleanup";}
    @Override public Map<String,String> getDefaultRunnerProperties(){return new LinkedHashMap<>(RunnerSettings.DEFAULTS);}
    @Override public PropertiesProcessor getRunnerPropertiesProcessor(){return properties->{
        List<InvalidProperty> errors=new ArrayList<>();
        try {RunnerSettings.validate(properties);}catch(IllegalArgumentException failure){errors.add(new InvalidProperty(failure instanceof RunnerSettings.InputException ? ((RunnerSettings.InputException)failure).field : "url",failure.getMessage()));}
        return errors;
    };}
    @Override public String getEditRunnerParamsJspFilePath(){return descriptor.getPluginResourcesPath("editRunner.jsp");}
    @Override public String getViewRunnerParamsJspFilePath(){return descriptor.getPluginResourcesPath("viewRunner.jsp");}
    @Override public String describeParameters(Map<String,String> parameters){return "Device profile: "+parameters.getOrDefault("profile","").replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\"","&quot;");}
}
