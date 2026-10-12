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

public sealed record RoomQueueItemDto(
    [property: JsonPropertyName("queueItemId")] string QueueItemId,
    [property: JsonPropertyName("videoId")] string VideoId,
    [property: JsonPropertyName("addedBy")] string AddedBy,
    [property: JsonPropertyName("addedAtUnixMs")] long AddedAtUnixMs);

public sealed record RoomTransitionDto(
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("groupId")] string GroupId,
    [property: JsonPropertyName("groupName")] string GroupName,
    [property: JsonPropertyName("announcedBy")] string AnnouncedBy,
    [property: JsonPropertyName("announcedAtUnixMs")] long AnnouncedAtUnixMs);

public sealed record YouTubeRoomSummaryDto(
    [property: JsonPropertyName("roomId")] string RoomId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("videoId")] string? VideoId,
    [property: JsonPropertyName("memberCount")] int MemberCount,
    [property: JsonPropertyName("connectedMemberCount")] int ConnectedMemberCount,
    [property: JsonPropertyName("createdAtUnixMs")] long CreatedAtUnixMs,
    [property: JsonPropertyName("expiresAtUnixMs")] long ExpiresAtUnixMs);

public sealed record YouTubeRoomDto(
    [property: JsonPropertyName("inviteToken")] string InviteToken,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("serverNowUnixMs")] long ServerNowUnixMs,
    [property: JsonPropertyName("createdAtUnixMs")] long CreatedAtUnixMs,
    [property: JsonPropertyName("expiresAtUnixMs")] long ExpiresAtUnixMs,
    [property: JsonPropertyName("timeline")] RoomTimelineDto Timeline,
    [property: JsonPropertyName("queue")] IReadOnlyList<RoomQueueItemDto> Queue,
    [property: JsonPropertyName("transition")] RoomTransitionDto? Transition,
    [property: JsonPropertyName("members")] IReadOnlyList<RoomMemberDto> Members);

public sealed class RoomAccessException : Exception
{
    public RoomAccessException(int statusCode, string message) : base(message) => StatusCode = statusCode;
    public int StatusCode { get; }
}

public sealed class YouTubeRoomStore
{
    public const int ProtocolVersion = 3;
    public static readonly TimeSpan RoomLifetime = TimeSpan.FromHours(6);
    private static readonly TimeSpan ConnectedWindow = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan MemberRetention = TimeSpan.FromMinutes(1);
    private static readonly Regex VideoIdPattern = new("^[A-Za-z0-9_-]{11}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex TokenPattern = new("^[A-Za-z0-9_-]{43}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex QueueItemIdPattern = new("^[0-9a-f]{32}$", RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex GroupIdPattern = new("^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private readonly object _gate = new();
    private readonly Dictionary<string, Room> _rooms = new(StringComparer.Ordinal);

    public YouTubeRoomDto Create(Guid userId, string displayName, Guid clientId, string? name, string videoId)
    {
        ValidateVideoId(videoId);
        lock (_gate)
        {
            CleanupExpired(DateTimeOffset.UtcNow);
            if (_rooms.Count >= 100) throw new RoomAccessException(409, "The server room limit has been reached.");
            var now = DateTimeOffset.UtcNow;
            string token;
            do { token = CreateToken(); } while (_rooms.ContainsKey(token));
            var room = new Room(token, NormalizeRoomName(name, displayName), now, now.Add(RoomLifetime), videoId, displayName);
            room.UpsertMember(userId, displayName, clientId, "paused", now);
            _rooms.Add(token, room);
            return Snapshot(room, now);
        }
    }

    public IReadOnlyList<YouTubeRoomSummaryDto> ListOpenRooms()
    {
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            CleanupExpired(now);
            foreach (var room in _rooms.Values) PruneMembers(room, now);
            foreach (var token in _rooms.Where(entry => entry.Value.Members.Count == 0).Select(entry => entry.Key).ToArray()) _rooms.Remove(token);
            return _rooms.Values
                .OrderBy(room => room.CreatedAt)
                .Select(room => new YouTubeRoomSummaryDto(
                    room.Token,
                    room.Name,
                    room.VideoId,
                    room.Members.Count,
                    room.Members.Values.Count(member => now - member.LastSeen <= ConnectedWindow),
                    room.CreatedAt.ToUnixTimeMilliseconds(),
                    room.ExpiresAt.ToUnixTimeMilliseconds()))
                .ToArray();
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
            var actor = room.Members[MemberKey(userId, clientId)].DisplayName;
            room.Queue.Clear();
            room.Queue.Add(CreateQueueItem(videoId, actor, now));
            SetCurrent(room, videoId, now, actor);
            return Snapshot(room, now);
        }
    }

    public YouTubeRoomDto AddToQueue(string token, Guid userId, Guid clientId, IReadOnlyList<string> videoIds, bool playNow)
    {
        if (videoIds.Count is < 1 or > 25) throw new RoomAccessException(400, "Add between 1 and 25 videos at a time.");
        foreach (var videoId in videoIds) ValidateVideoId(videoId);
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var room = RequireMember(token, userId, clientId, now);
            if (room.Queue.Count + videoIds.Count > 100) throw new RoomAccessException(400, "A YouTube room queue can contain up to 100 videos.");
            var actor = room.Members[MemberKey(userId, clientId)].DisplayName;
            var additions = videoIds.Select(videoId => CreateQueueItem(videoId, actor, now)).ToArray();
            if (playNow)
            {
                room.Queue.InsertRange(0, additions);
                SetCurrent(room, additions[0].VideoId, now, actor);
            }
            else
            {
                var startQueue = room.Queue.Count == 0 || room.VideoId is null;
                room.Queue.AddRange(additions);
                if (startQueue) SetCurrent(room, room.Queue[0].VideoId, now, actor);
            }
            return Snapshot(room, now);
        }
    }

    public YouTubeRoomDto QueueAction(string token, Guid userId, Guid clientId, string queueItemId, string action)
    {
        if (!QueueItemIdPattern.IsMatch(queueItemId) || action is not ("play" or "remove" or "move-up" or "move-down"))
            throw new RoomAccessException(400, "Invalid queue action.");
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var room = RequireMember(token, userId, clientId, now);
            var actor = room.Members[MemberKey(userId, clientId)].DisplayName;
            var index = room.Queue.FindIndex(item => string.Equals(item.QueueItemId, queueItemId, StringComparison.OrdinalIgnoreCase));
            if (index < 0) throw new RoomAccessException(404, "Queue item not found.");
            if (action == "play" && index > 0)
            {
                var item = room.Queue[index];
                room.Queue.RemoveAt(index);
                room.Queue.Insert(0, item);
                SetCurrent(room, item.VideoId, now, actor);
            }
            else if (action == "remove")
            {
                room.Queue.RemoveAt(index);
                if (index == 0) SetCurrent(room, room.Queue.FirstOrDefault()?.VideoId, now, actor);
            }
            else if (action == "move-up" && index > 1)
                (room.Queue[index - 1], room.Queue[index]) = (room.Queue[index], room.Queue[index - 1]);
            else if (action == "move-down" && index > 0 && index < room.Queue.Count - 1)
                (room.Queue[index + 1], room.Queue[index]) = (room.Queue[index], room.Queue[index + 1]);
            return Snapshot(room, now);
        }
    }

    public YouTubeRoomDto Advance(string token, Guid userId, Guid clientId, string expectedVideoId, string? expectedQueueItemId = null)
    {
        ValidateVideoId(expectedVideoId);
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var room = RequireMember(token, userId, clientId, now);
            if (!string.Equals(room.VideoId, expectedVideoId, StringComparison.Ordinal)) return Snapshot(room, now);
            if (expectedQueueItemId is not null && room.Queue.FirstOrDefault()?.QueueItemId != expectedQueueItemId) return Snapshot(room, now);
            // Older v3 clients cannot distinguish consecutive copies of the same video.
            // Leave that ambiguous transition to an upgraded client or an explicit queue action.
            if (expectedQueueItemId is null && room.Queue.Skip(1).FirstOrDefault()?.VideoId == expectedVideoId) return Snapshot(room, now);
            var actor = room.Members[MemberKey(userId, clientId)].DisplayName;
            if (room.Queue.Count > 0) room.Queue.RemoveAt(0);
            SetCurrent(room, room.Queue.FirstOrDefault()?.VideoId, now, actor);
            return Snapshot(room, now);
        }
    }

    public YouTubeRoomDto Handoff(string token, Guid userId, Guid clientId, string groupId, string groupName)
    {
        if (!GroupIdPattern.IsMatch(groupId) || string.IsNullOrWhiteSpace(groupName) || groupName.Length > 200 || groupName.Any(char.IsControl))
            throw new RoomAccessException(400, "Invalid Jellyfin watch-party destination.");
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var room = RequireMember(token, userId, clientId, now);
            var actor = room.Members[MemberKey(userId, clientId)].DisplayName;
            room.Transition = new RoomTransition("jellyfin-syncplay", groupId, groupName.Trim(), actor, now);
            room.Playing = false;
            room.AnchoredAt = now;
            room.Version++;
            room.ChangedBy = actor;
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
        PruneMembers(room, now);
        if (!room.Members.ContainsKey(MemberKey(userId, clientId))) throw new RoomAccessException(403, "Join this room before changing it.");
        return room;
    }

    private static YouTubeRoomDto Snapshot(Room room, DateTimeOffset now)
    {
        PruneMembers(room, now);
        var members = room.Members.Values
            .OrderBy(member => member.DisplayName, StringComparer.OrdinalIgnoreCase)
            .Select(member => new RoomMemberDto(member.MemberId, member.DisplayName, member.Status, now - member.LastSeen <= ConnectedWindow, member.LastSeen.ToUnixTimeMilliseconds()))
            .ToArray();
        return new YouTubeRoomDto(
            room.Token,
            room.Name,
            now.ToUnixTimeMilliseconds(),
            room.CreatedAt.ToUnixTimeMilliseconds(),
            room.ExpiresAt.ToUnixTimeMilliseconds(),
            new RoomTimelineDto(room.VideoId, room.PositionSeconds, room.Playing, room.AnchoredAt.ToUnixTimeMilliseconds(), room.Version, room.ChangedBy),
            room.Queue.Select(item => new RoomQueueItemDto(item.QueueItemId, item.VideoId, item.AddedBy, item.AddedAt.ToUnixTimeMilliseconds())).ToArray(),
            room.Transition is null ? null : new RoomTransitionDto(room.Transition.Kind, room.Transition.GroupId, room.Transition.GroupName, room.Transition.AnnouncedBy, room.Transition.AnnouncedAt.ToUnixTimeMilliseconds()),
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

    private static QueueItem CreateQueueItem(string videoId, string addedBy, DateTimeOffset now) => new(Guid.NewGuid().ToString("N"), videoId, addedBy, now);

    private static void SetCurrent(Room room, string? videoId, DateTimeOffset now, string changedBy)
    {
        room.VideoId = videoId;
        room.PositionSeconds = 0;
        room.Playing = false;
        room.AnchoredAt = now;
        room.Version++;
        room.ChangedBy = changedBy;
    }

    private static void PruneMembers(Room room, DateTimeOffset now)
    {
        foreach (var key in room.Members.Where(entry => now - entry.Value.LastSeen > MemberRetention).Select(entry => entry.Key).ToArray()) room.Members.Remove(key);
    }

    private static string NormalizeRoomName(string? name, string displayName)
    {
        var value = string.IsNullOrWhiteSpace(name) ? $"{displayName}'s YouTube room" : name.Trim();
        if (value.Length > 80 || value.Any(char.IsControl)) throw new RoomAccessException(400, "Room name must be 80 characters or fewer.");
        return value;
    }

    private static string MemberKey(Guid userId, Guid clientId) => $"{userId:N}:{clientId:N}";
    private static string CreateToken() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private sealed class Room
    {
        public Room(string token, string name, DateTimeOffset createdAt, DateTimeOffset expiresAt, string videoId, string addedBy)
        {
            Token = token; Name = name; CreatedAt = createdAt; ExpiresAt = expiresAt; VideoId = videoId; AnchoredAt = createdAt;
            Queue.Add(CreateQueueItem(videoId, addedBy, createdAt));
        }
        public string Token { get; }
        public string Name { get; }
        public DateTimeOffset CreatedAt { get; }
        public DateTimeOffset ExpiresAt { get; }
        public string? VideoId { get; set; }
        public double PositionSeconds { get; set; }
        public bool Playing { get; set; }
        public DateTimeOffset AnchoredAt { get; set; }
        public long Version { get; set; }
        public string? ChangedBy { get; set; }
        public List<QueueItem> Queue { get; } = [];
        public RoomTransition? Transition { get; set; }
        public Dictionary<string, Member> Members { get; } = new(StringComparer.Ordinal);
        public void UpsertMember(Guid userId, string displayName, Guid clientId, string status, DateTimeOffset now)
        {
            var key = MemberKey(userId, clientId);
            PruneMembers(this, now);
            if (!Members.ContainsKey(key) && Members.Count >= 32) throw new RoomAccessException(409, "This room is full.");
            Members[key] = new Member(key, displayName, status, now);
        }
    }

    private sealed record Member(string MemberId, string DisplayName, string Status, DateTimeOffset LastSeen);
    private sealed record QueueItem(string QueueItemId, string VideoId, string AddedBy, DateTimeOffset AddedAt);
    private sealed record RoomTransition(string Kind, string GroupId, string GroupName, string AnnouncedBy, DateTimeOffset AnnouncedAt);
}
