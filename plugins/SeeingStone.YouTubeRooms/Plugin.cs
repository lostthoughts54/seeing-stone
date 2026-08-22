using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Serialization;
using SeeingStone.YouTubeRooms.Configuration;

namespace SeeingStone.YouTubeRooms;

public sealed class Plugin : BasePlugin<PluginConfiguration>
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }
    public override string Name => "Seeing Stone YouTube Rooms";
    public override Guid Id => Guid.Parse("ba1e7220-03eb-4f16-86a8-6dff57b896bf");
}
