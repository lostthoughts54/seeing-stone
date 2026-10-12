using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace SeeingStone.YouTubeRooms;

public sealed class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<YouTubeRoomStore>();
        serviceCollection.AddSingleton(provider => new PlayerFeatureRooms(Path.Combine(provider.GetRequiredService<MediaBrowser.Common.Configuration.IApplicationPaths>().PluginConfigurationsPath, "seeing-stone-rooms.json")));
        serviceCollection.AddSingleton(provider => new FeatureCorrections(Path.Combine(provider.GetRequiredService<MediaBrowser.Common.Configuration.IApplicationPaths>().PluginConfigurationsPath, "seeing-stone-subtitle-timing.json")));
    }
}
