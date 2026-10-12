using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace SeeingStone.YouTubeRooms;

public sealed record FeatureCommand(string Operation, string? RoomId, string? Name, string? Kind, string? ItemId, string? MediaSourceId,
    FeatureReport? Report, FeatureAction? Action, string? Text, long? PositionTicks, string? Stream, double? DelaySeconds, string? Version);

[ApiController, Authorize, Route("SeeingStone/PlayerFeatures")]
public sealed class PlayerFeaturesController(PlayerFeatureRooms rooms, FeatureCorrections corrections, IAuthorizationContext authorizationContext, ILibraryManager library) : ControllerBase
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };

    [HttpGet]
    public IActionResult Capabilities() => new JsonResult(new { protocolVersion = 1, name = "Seeing Stone Player Features", features = new[] { "persistent-rooms", "readiness", "preflight", "queue-votes", "download-preparation", "subtitle-timing", "shared-skips", "chat", "diagnostics", "youtube-v3" } }, JsonOptions);

    [HttpPost("command"), RequestSizeLimit(16384)]
    public async Task<IActionResult> Command([FromBody] JsonElement body)
    {
        try
        {
            var request = body.Deserialize<FeatureCommand>(JsonOptions) ?? throw new RoomAccessException(400, "Invalid request.");
            var auth = await authorizationContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
            if (!auth.IsAuthenticated || auth.UserId == Guid.Empty || auth.User is null || string.IsNullOrEmpty(auth.Token)) throw new RoomAccessException(401, "Sign in with a Jellyfin user account.");
            // Exact authenticated session identity; neither names nor session credentials come from the body.
            var session = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(auth.Token)))[..32];
            var displayName = new string(auth.User.Username.Where(c => !char.IsControl(c)).Take(80).ToArray());
            if (string.IsNullOrWhiteSpace(displayName)) displayName = "Jellyfin viewer";
            var id = request.RoomId ?? "";
            object result;
            switch (request.Operation)
            {
                case "list": result = rooms.List().Select(r => r with { Title = null }).ToArray(); break;
                case "create": result = rooms.Create(auth.UserId, session, request.Name ?? "", displayName); break;
                case "join": result = rooms.Join(id, auth.UserId, session, displayName); break;
                case "get": result = rooms.Get(id, auth.UserId, session); break;
                case "leave": rooms.Leave(id, auth.UserId, session); result = new { ok = true }; break;
                case "delete": rooms.Delete(id, auth.UserId, session); result = new { ok = true }; break;
                case "report": result = rooms.Report(id, auth.UserId, session, request.Report ?? throw new RoomAccessException(400, "Missing report.")); break;
                case "add": result = rooms.Add(id, auth.UserId, session, Resolve(request.Kind, request.ItemId, request.MediaSourceId, auth)); break;
                case "action": result = rooms.Action(id, auth.UserId, session, request.Action ?? throw new RoomAccessException(400, "Missing action.")); break;
                case "message": result = rooms.Message(id, auth.UserId, session, request.Kind ?? "chat", request.Text ?? "", request.PositionTicks); break;
                case "preflight":
                    var media = Resolve(request.Kind, request.ItemId, request.MediaSourceId, auth);
                    var source = media.Kind == "jellyfin" ? library.GetItemById(Guid.Parse(media.ItemId))!.GetMediaSources(false).First(s => s.Id == media.MediaSourceId) : null;
                    result = new { media, subtitles = source?.MediaStreams.Where(s => s.Type == MediaBrowser.Model.Entities.MediaStreamType.Subtitle).Select(s => new { s.Index, s.Language, s.Codec, s.IsExternal }).ToArray(), delaySeconds = corrections.Get(auth.UserId, media, request.Stream ?? "default") }; break;
                case "timing":
                    var timingMedia = Resolve(request.Kind, request.ItemId, request.MediaSourceId, auth);
                    if (request.Version is not null && request.Version != timingMedia.Version) throw new RoomAccessException(409, "The media version changed. Prepare this video again before adjusting subtitles.");
                    var stream = request.Stream ?? "default";
                    if (stream.Length > 80 || stream.Any(char.IsControl)) throw new RoomAccessException(400, "Invalid subtitle stream.");
                    if (request.DelaySeconds is double delay) corrections.Set(auth.UserId, timingMedia, stream, delay);
                    result = new { delaySeconds = corrections.Get(auth.UserId, timingMedia, stream) }; break;
                default: throw new RoomAccessException(400, "Unknown feature command.");
            }
            if (result is FeatureRoomView room)
            {
                FeatureMedia Visible(FeatureMedia media) => CanSee(media, auth) ? media : media with { Title = "Unavailable to this account", MediaSourceId = null, Version = "", DurationTicks = 0 };
                result = room with { Media = room.Media is null ? null : Visible(room.Media), Queue = room.Queue.Select(q => q with { Media = Visible(q.Media) }).ToArray() };
            }
            return new JsonResult(result, JsonOptions);
        }
        catch (RoomAccessException error) { return StatusCode(error.StatusCode, new { error = error.Message }); }
        catch (JsonException) { return BadRequest(new { error = "Invalid feature request." }); }
    }

    private bool CanSee(FeatureMedia media, AuthorizationInfo auth) => media.Kind == "youtube" || (Guid.TryParse(media.ItemId, out var id) && library.GetItemById(id)?.IsVisibleStandalone(auth.User!) == true);
    private FeatureMedia Resolve(string? kind, string? itemId, string? sourceId, AuthorizationInfo auth)
    {
        if (kind == "youtube")
        {
            if (itemId is null || !System.Text.RegularExpressions.Regex.IsMatch(itemId, "^[A-Za-z0-9_-]{11}$")) throw new RoomAccessException(400, "Invalid YouTube video.");
            return new("youtube", itemId, null, $"YouTube · {itemId}", 0, itemId);
        }
        if (kind != "jellyfin" || !Guid.TryParse(itemId, out var id)) throw new RoomAccessException(400, "Invalid library item.");
        var item = library.GetItemById(id);
        if (item is not MediaBrowser.Controller.Entities.Video || !item.IsVisibleStandalone(auth.User!)) throw new RoomAccessException(403, "This video is unavailable to your account.");
        var sources = item.GetMediaSources(false);
        var source = sourceId is null ? sources.FirstOrDefault() : sources.FirstOrDefault(s => s.Id == sourceId);
        if (source is null) throw new RoomAccessException(409, "That media version is unavailable.");
        var version = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{source.Id}:{source.Size}:{source.RunTimeTicks}:{item.DateModified.Ticks}")));
        return new("jellyfin", id.ToString("N"), source.Id, item.Name.Length > 512 ? item.Name[..512] : item.Name, source.RunTimeTicks ?? 0, version);
    }
}

public sealed class FeatureCorrections
{
    private readonly object _gate = new();
    private readonly string _path;
    private readonly Dictionary<string, double> _values;
    public FeatureCorrections(string path) { _path = path; _values = File.Exists(path) ? JsonSerializer.Deserialize<Dictionary<string, double>>(File.ReadAllText(path)) ?? new() : new(); }
    private static string Key(Guid user, FeatureMedia media, string stream) => $"{user:N}:{media.ItemId}:{media.Version}:{stream}";
    public double Get(Guid user, FeatureMedia media, string stream) { lock (_gate) return _values.GetValueOrDefault(Key(user, media, stream)); }
    public void Set(Guid user, FeatureMedia media, string stream, double seconds)
    {
        if (!double.IsFinite(seconds) || Math.Abs(seconds) > 120) throw new RoomAccessException(400, "Subtitle timing must be within two minutes.");
        lock (_gate)
        {
            var key = Key(user, media, stream);
            if (seconds == 0) _values.Remove(key);
            else { if (_values.Count >= 10000 && !_values.ContainsKey(key)) throw new RoomAccessException(409, "Saved timing limit reached."); _values[key] = seconds; }
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            File.WriteAllText(_path + ".tmp", JsonSerializer.Serialize(_values)); File.Move(_path + ".tmp", _path, true);
        }
    }
}
