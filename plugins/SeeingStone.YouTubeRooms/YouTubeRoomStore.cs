using System.Security.Cryptography;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace SeeingStone.YouTubeRooms;

public sealed record RoomMemberDto(
    [property: JsonPropertyName("memberId")] string MemberId,
    [property: JsonPropertyName("displayName")] string DisplayName,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("connected")] bool Connected,
    [property: JsonPropertyName("lastSeenAtUnixMs")] long LastSeenAtUnixMs);

public sealed record RoomTimelineDto(
    [property: JsonPropertyName("videoId")] string? VideoId,
    [property: JsonPropertyName("positionSeconds")] double PositionSeconds,
    [property: JsonPropertyName("playing")] bool Playing,
    [property: JsonPropertyName("anchoredAtUnixMs")] long AnchoredAtUnixMs,
    [property: JsonPropertyName("version")] long Version,
    [property: JsonPropertyName("changedBy")] string? ChangedBy);

public sealed record YouTubeRoomDto(
    [property: JsonPropertyName("inviteToken")] string InviteToken,
    [property: JsonPropertyName("serverNowUnixMs")] long ServerNowUnixMs,
    [property: JsonPropertyName("createdAtUnixMs")] long CreatedAtUnixMs,
    [property: JsonPropertyName("expiresAtUnixMs")] long ExpiresAtUnixMs,
    [property: JsonPropertyName("timeline")] RoomTimelineDto Timeline,
    [property: JsonPropertyName("members")] IReadOnlyList<RoomMemberDto> Members);

public sealed class RoomAccessException : Exception
{
    public RoomAccessException(int statusCode, string message) : base(message) => StatusCode = statusCode;
    public int StatusCode { get; }
}

public sealed class YouTubeRoomStore
{
    public const int ProtocolVersion = 1;
    public static readonly TimeSpan RoomLifetime = TimeSpan.FromHours(6);
    private static readonly TimeSpan ConnectedWindow = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan MemberRetention = TimeSpan.FromMinutes(1);
    private static readonly Regex VideoIdPattern = new("^[A-Za-z0-9_-]{11}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex TokenPattern = new("^[A-Za-z0-9_-]{43}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private readonly object _gate = new();
    private readonly Dictionary<string, Room> _rooms = new(StringComparer.Ordinal);

    public YouTubeRoomDto Create(Guid userId, string displayName, Guid clientId, string videoId)
    {
        ValidateVideoId(videoId);
        lock (_gate)
        {
            CleanupExpired(DateTimeOffset.UtcNow);
            var now = DateTimeOffset.UtcNow;
            string token;
            do { token = CreateToken(); } while (_rooms.ContainsKey(token));
            var room = new Room(token, now, now.Add(RoomLifetime), videoId);
            room.UpsertMember(userId, displayName, clientId, "paused", now);
            _rooms.Add(token, room);
            return Snapshot(room, now);
        }
    }

    public YouTubeRoomDto Join(string token, Guid userId, string displayName, Guid clientId)
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var room = RequireRoom(token, now);
            room.UpsertMember(userId, displayName, clientId, "idle", now);
            return Snapshot(room, now);
        }
    }

    public YouTubeRoomDto Presence(string token, Guid userId, string displayName, Guid clientId, string status)
    {
        if (status is not ("idle" or "playing" or "paused" or "buffering" or "recovering"))
            throw new RoomAccessException(400, "Invalid presence status.");
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var room = RequireMember(token, userId, clientId, now);
            room.UpsertMember(userId, displayName, clientId, status, now);
            return Snapshot(room, now);
        }
    }

    public YouTubeRoomDto SetVideo(string token, Guid userId, Guid clientId, string videoId)
    {
        ValidateVideoId(videoId);
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var room = RequireMember(token, userId, clientId, now);
            room.VideoId = videoId;
            room.PositionSeconds = 0;
            room.Playing = false;
            room.AnchoredAt = now;
            room.Version++;
            room.ChangedBy = room.Members[MemberKey(userId, clientId)].DisplayName;
            return Snapshot(room, now);
        }
    }

    public YouTubeRoomDto ApplyAction(string token, Guid userId, Guid clientId, string action, double positionSeconds)
    {
        if (action is not ("play" or "pause" or "seek") || !double.IsFinite(positionSeconds) || positionSeconds < 0 || positionSeconds > 86400)
            throw new RoomAccessException(400, "Invalid playback action.");
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var room = RequireMember(token, userId, clientId, now);
            room.PositionSeconds = positionSeconds;
            if (action == "play") room.Playing = true;
            if (action == "pause") room.Playing = false;
            room.AnchoredAt = now;
            room.Version++;
            room.ChangedBy = room.Members[MemberKey(userId, clientId)].DisplayName;
            return Snapshot(room, now);
        }
    }

    public void Leave(string token, Guid userId, Guid clientId)
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var room = RequireRoom(token, now);
            room.Members.Remove(MemberKey(userId, clientId));
            if (room.Members.Count == 0) _rooms.Remove(token);
        }
    }

    private Room RequireRoom(string token, DateTimeOffset now)
    {
        if (!TokenPattern.IsMatch(token)) throw new RoomAccessException(404, "Room not found.");
        if (!_rooms.TryGetValue(token, out var room)) throw new RoomAccessException(404, "Room not found.");
        if (room.ExpiresAt <= now)
        {
            _rooms.Remove(token);
            throw new RoomAccessException(410, "Room expired.");
        }
        return room;
    }

    private Room RequireMember(string token, Guid userId, Guid clientId, DateTimeOffset now)
    {
        var room = RequireRoom(token, now);
        if (!room.Members.ContainsKey(MemberKey(userId, clientId))) throw new RoomAccessException(403, "Join this room before changing it.");
        return room;
    }

    private static YouTubeRoomDto Snapshot(Room room, DateTimeOffset now)
    {
        foreach (var key in room.Members.Where(entry => now - entry.Value.LastSeen > MemberRetention).Select(entry => entry.Key).ToArray()) room.Members.Remove(key);
        var members = room.Members.Values
            .OrderBy(member => member.DisplayName, StringComparer.OrdinalIgnoreCase)
            .Select(member => new RoomMemberDto(member.MemberId, member.DisplayName, member.Status, now - member.LastSeen <= ConnectedWindow, member.LastSeen.ToUnixTimeMilliseconds()))
            .ToArray();
        return new YouTubeRoomDto(
            room.Token,
            now.ToUnixTimeMilliseconds(),
            room.CreatedAt.ToUnixTimeMilliseconds(),
            room.ExpiresAt.ToUnixTimeMilliseconds(),
            new RoomTimelineDto(room.VideoId, room.PositionSeconds, room.Playing, room.AnchoredAt.ToUnixTimeMilliseconds(), room.Version, room.ChangedBy),
            members);
    }

    private void CleanupExpired(DateTimeOffset now)
    {
        foreach (var token in _rooms.Where(entry => entry.Value.ExpiresAt <= now).Select(entry => entry.Key).ToArray()) _rooms.Remove(token);
    }

    private static void ValidateVideoId(string videoId)
    {
        if (!VideoIdPattern.IsMatch(videoId)) throw new RoomAccessException(400, "Invalid YouTube video id.");
    }

    private static string MemberKey(Guid userId, Guid clientId) => $"{userId:N}:{clientId:N}";
    private static string CreateToken() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private sealed class Room
    {
        public Room(string token, DateTimeOffset createdAt, DateTimeOffset expiresAt, string videoId)
        {
            Token = token; CreatedAt = createdAt; ExpiresAt = expiresAt; VideoId = videoId; AnchoredAt = createdAt;
        }
        public string Token { get; }
        public DateTimeOffset CreatedAt { get; }
        public DateTimeOffset ExpiresAt { get; }
        public string? VideoId { get; set; }
        public double PositionSeconds { get; set; }
        public bool Playing { get; set; }
        public DateTimeOffset AnchoredAt { get; set; }
        public long Version { get; set; }
        public string? ChangedBy { get; set; }
        public Dictionary<string, Member> Members { get; } = new(StringComparer.Ordinal);
        public void UpsertMember(Guid userId, string displayName, Guid clientId, string status, DateTimeOffset now)
        {
            var key = MemberKey(userId, clientId);
            Members[key] = new Member(key, displayName, status, now);
        }
    }

    private sealed record Member(string MemberId, string DisplayName, string Status, DateTimeOffset LastSeen);
}
