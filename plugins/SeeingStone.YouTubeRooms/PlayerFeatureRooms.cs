using System.Text.Json;

namespace SeeingStone.YouTubeRooms;

public sealed record FeatureMedia(string Kind, string ItemId, string? MediaSourceId, string Title, long DurationTicks, string Version);
public sealed record FeatureQueueEntry(string Id, FeatureMedia Media, string AddedBy, int Votes, bool Voted);
public sealed record FeatureReport(long Generation, string State, bool Ready, long PositionTicks, long? BufferTicks, string? Source, string? Version, string? Issue, string Preparation, long TargetRevision = 0);
public sealed record FeatureMember(string Id, string Name, bool Host, string State, bool Ready, bool Connected, long SeenAt, long PositionTicks, long? BufferTicks, string? Source, string? Issue, string Preparation);
public sealed record FeatureTimeline(long Version, long Generation, long PositionTicks, bool Playing, long AnchoredAt, long? StartAt, long? NextAt, string Phase, long TargetRevision);
public sealed record FeatureMessage(string Id, string Author, string Kind, string Text, long CreatedAt, long? PositionTicks, long Generation);
public sealed record FeatureEvent(string Id, long At, string Text);
public sealed record FeatureRoomView(string Id, string Name, long ServerNow, bool Owner, bool HostOnly, bool WaitForAll, int MinimumParticipants, bool AutoNext, FeatureTimeline Timeline, FeatureMedia? Media, FeatureQueueEntry[] Queue, FeatureMember[] Members, FeatureMessage[] Messages, FeatureEvent[] Events);
public sealed record FeatureRoomSummary(string Id, string Name, string? Title, int Connected, long UpdatedAt);
public sealed record FeatureAction(string Action, string? QueueItemId = null, long? PositionTicks = null, long? ExpectedGeneration = null, bool? Enabled = null, int? MinimumParticipants = null);

/// <summary>Plugin-owned rooms: membership never depends on SyncPlay's private session map.</summary>
public sealed class PlayerFeatureRooms
{
    private readonly object _gate = new();
    private readonly string? _path;
    private readonly Func<long> _now;
    private readonly Dictionary<string, Room> _rooms = new(StringComparer.Ordinal);
    private long _lastSaved;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public PlayerFeatureRooms(string? path = null, Func<long>? now = null)
    {
        _path = path; _now = now ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        if (path is null || !File.Exists(path)) return;
        // A damaged store must be reported by startup, never silently replaced.
        foreach (var room in JsonSerializer.Deserialize<List<Room>>(File.ReadAllText(path), JsonOptions) ?? [])
        {
            if (_rooms.Count >= 64) break;
            room.Position = Position(room, room.UpdatedAt); room.Playing = false; room.StartAt = null;
            room.NextAt = null; room.WantsPlay = false; room.Phase = "paused"; room.Members.Clear();
            room.Messages = room.Messages.TakeLast(200).ToList(); room.Events = room.Events.TakeLast(300).ToList();
            _rooms[room.Id] = room;
        }
    }

    public FeatureRoomSummary[] List()
    {
        lock (_gate)
        {
            foreach (var room in _rooms.Values) Tick(room);
            Save(false);
            return _rooms.Values.OrderByDescending(r => r.UpdatedAt)
                .Select(r => new FeatureRoomSummary(r.Id, r.Name, r.Queue.FirstOrDefault()?.Media.Title, Active(r).Length, r.UpdatedAt)).ToArray();
        }
    }

    public FeatureRoomView Create(Guid user, string session, string name, string displayName)
    {
        name = Text(name, 80);
        lock (_gate)
        {
            if (_rooms.Count >= 64 || _rooms.Values.Count(r => r.Owner == user) >= 8) throw new RoomAccessException(409, "Room limit reached. Delete an unused room first.");
            var room = new Room { Id = Guid.NewGuid().ToString("N"), Owner = user, Name = name, UpdatedAt = _now(), Anchor = _now() };
            _rooms.Add(room.Id, room); JoinMember(room, user, session, displayName);
            Event(room, "Room created."); Save(true); return View(room, user, session);
        }
    }

    public FeatureRoomView Join(string id, Guid user, string session, string name)
    {
        lock (_gate) { var r = Require(id); JoinMember(r, user, session, name); Tick(r); Save(true); return View(r, user, session); }
    }

    public FeatureRoomView Get(string id, Guid user, string session)
    {
        lock (_gate) { var r = RequireMember(id, user, session); Tick(r); return View(r, user, session); }
    }

    public void Leave(string id, Guid user, string session)
    {
        lock (_gate) { var r = RequireMember(id, user, session); var member = r.Members[session]; r.Members.Remove(session); Event(r, $"{member.Name} left."); Tick(r); Save(true); }
    }

    public void Delete(string id, Guid user, string session)
    {
        lock (_gate) { var r = RequireMember(id, user, session); Host(r, user); _rooms.Remove(id); Save(true); }
    }

    public FeatureRoomView Report(string id, Guid user, string session, FeatureReport report)
    {
        if (report.State is not ("loading" or "ready" or "playing" or "paused" or "buffering" or "error" or "ended" or "idle")) throw new RoomAccessException(400, "Invalid player status.");
        if (report.PositionTicks < 0 || report.PositionTicks > 864_000_000_000 || report.BufferTicks < 0 || report.BufferTicks > 864_000_000_000) throw new RoomAccessException(400, "Invalid player position.");
        lock (_gate)
        {
            var r = RequireMember(id, user, session); var m = r.Members[session]; m.SeenAt = _now();
            if (report.Generation == r.Generation)
            {
                if (report.State != m.Report.State) { m.StateSince = _now(); Event(r, $"{m.Name}: {report.State}."); }
                m.Report = report with { Ready = report.Ready && report.TargetRevision == r.TargetRevision && report.Version == r.Queue.FirstOrDefault()?.Media.Version, Source = Short(report.Source, 40), Version = Short(report.Version, 128), Issue = Short(report.Issue, 240), Preparation = Short(report.Preparation, 120) ?? "" };
                var current = r.Queue.FirstOrDefault()?.Media;
                var nearEnd = current is not null && (current.DurationTicks == 0 || (report.PositionTicks >= current.DurationTicks - 20_000_000 && Position(r, _now()) >= current.DurationTicks - 20_000_000));
                if (report.State == "ended" && report.Version == current?.Version && nearEnd && r.HasStarted && r.NextAt is null && r.Phase != "ended")
                {
                    Freeze(r); r.WantsPlay = false; r.Version++;
                    if (r.AutoNext && r.Queue.Count > 1) { r.NextAt = _now() + 5000; r.Phase = "next"; Event(r, "Next item starts in five seconds."); }
                    else { r.Phase = "ended"; Event(r, "Video finished."); }
                }
            }
            Tick(r); Save(false); return View(r, user, session);
        }
    }

    public FeatureRoomView Add(string id, Guid user, string session, FeatureMedia media)
    {
        lock (_gate)
        {
            var r = RequireMember(id, user, session);
            if (r.Queue.Count >= 100) throw new RoomAccessException(409, "The room queue is full.");
            r.Queue.Add(new QueueEntry { Id = Guid.NewGuid().ToString("N"), Media = media, AddedBy = r.Members[session].Name });
            if (r.Queue.Count == 1) SelectCurrent(r);
            Event(r, "An item was added to the queue."); Save(true); return View(r, user, session);
        }
    }

    public FeatureRoomView Action(string id, Guid user, string session, FeatureAction action)
    {
        lock (_gate)
        {
            var r = RequireMember(id, user, session);
            if (action.ExpectedGeneration is not null && action.ExpectedGeneration != r.Generation) throw new RoomAccessException(409, "The room is now playing a different item.");
            if (action.Action == "vote")
            {
                var entry = r.Queue.FirstOrDefault(q => q.Id == action.QueueItemId) ?? throw new RoomAccessException(404, "Queue item not found.");
                if (!entry.Votes.Add(user)) entry.Votes.Remove(user);
            }
            else
            {
                if (r.HostOnly || action.Action is "host-only" or "wait-for-all" or "minimum" or "auto-next" or "prepare" or "continue") Host(r, user);
                switch (action.Action)
                {
                    case "play":
                        if (r.Queue.Count == 0) throw new RoomAccessException(409, "Add a video first.");
                        r.WantsPlay = true; r.Phase = "waiting"; break;
                    case "pause": Freeze(r); r.WantsPlay = false; r.NextAt = null; r.Phase = "paused"; break;
                    case "continue":
                        if (r.Queue.Count == 0) throw new RoomAccessException(409, "Add a video first.");
                        r.WaitForAll = false;
                        r.WantsPlay = false; r.Playing = true; r.StartAt = _now() + 1500; r.Anchor = r.StartAt.Value; r.Phase = "starting"; r.HasStarted = true; break;
                    case "seek":
                        var limit = r.Queue.FirstOrDefault()?.Media.DurationTicks ?? 0;
                        if (action.PositionTicks is not long position || position < 0 || position > (limit > 0 ? limit : 864_000_000_000)) throw new RoomAccessException(400, "Invalid seek position.");
                        var playing = r.Playing || r.WantsPlay; Freeze(r); r.Position = position; r.Anchor = _now(); r.WantsPlay = playing;
                        r.Phase = playing ? "waiting" : "paused"; r.TargetRevision++; InvalidateReady(r); break;
                    case "next":
                        if (r.Queue.Count == 0) break;
                        r.Queue.RemoveAt(0); SelectCurrent(r); r.WantsPlay = r.Queue.Count > 0; break;
                    case "play-item":
                        var selected = r.Queue.FindIndex(q => q.Id == action.QueueItemId);
                        if (selected < 0) throw new RoomAccessException(404, "Queue item not found.");
                        var item = r.Queue[selected]; r.Queue.RemoveAt(selected); r.Queue.Insert(0, item); SelectCurrent(r); break;
                    case "remove":
                        var index = r.Queue.FindIndex(q => q.Id == action.QueueItemId);
                        if (index < 0) throw new RoomAccessException(404, "Queue item not found.");
                        r.Queue.RemoveAt(index); if (index == 0) SelectCurrent(r); break;
                    case "sort-votes":
                        if (r.Queue.Count > 1) r.Queue = r.Queue.Take(1).Concat(r.Queue.Skip(1).OrderByDescending(q => q.Votes.Count)).ToList(); break;
                    case "host-only": r.HostOnly = action.Enabled ?? true; break;
                    case "wait-for-all": r.WaitForAll = action.Enabled ?? true; break;
                    case "auto-next": r.AutoNext = action.Enabled ?? true; break;
                    case "minimum":
                        if (action.MinimumParticipants is not (1 or 2)) throw new RoomAccessException(400, "Choose one or two participants.");
                        r.Minimum = action.MinimumParticipants.Value; break;
                    case "prepare": Event(r, "Prepare for movie night: each viewer can approve downloading the queue on their computer."); break;
                    default: throw new RoomAccessException(400, "Unknown room action.");
                }
            }
            r.Version++; Event(r, $"{r.Members[session].Name}: {action.Action}."); Tick(r); Save(true); return View(r, user, session);
        }
    }

    public FeatureRoomView Message(string id, Guid user, string session, string kind, string text, long? position)
    {
        if (kind is not ("chat" or "reaction" or "comment")) throw new RoomAccessException(400, "Invalid message type.");
        text = Text(text, kind == "reaction" ? 16 : 500);
        if (position is < 0 or > 864_000_000_000) throw new RoomAccessException(400, "Invalid comment position.");
        lock (_gate)
        {
            var r = RequireMember(id, user, session); var m = r.Members[session];
            if (_now() - m.LastMessageAt < 500) throw new RoomAccessException(429, "Please wait before sending another message.");
            m.LastMessageAt = _now();
            r.Messages.Add(new FeatureMessage(Guid.NewGuid().ToString("N"), m.Name, kind, text, _now(), kind == "comment" ? position ?? Position(r, _now()) : null, r.Generation));
            if (r.Messages.Count > 200) r.Messages.RemoveAt(0);
            Save(true); return View(r, user, session);
        }
    }

    private void Tick(Room r)
    {
        var now = _now();
        foreach (var key in r.Members.Where(p => now - p.Value.SeenAt > 600_000).Select(p => p.Key).ToArray()) r.Members.Remove(key);
        var active = Active(r);
        if (active.Length == 0) { if (r.Playing) { Freeze(r); r.Phase = "paused"; r.WantsPlay = false; Event(r, "Playback paused: no connected participants."); } return; }
        if (r.NextAt is long next && now >= next) { if (r.Queue.Count > 0) r.Queue.RemoveAt(0); SelectCurrent(r); r.WantsPlay = r.Queue.Count > 0; }
        var allReady = active.All(m => m.Report.Generation == r.Generation && m.Report.Ready && m.Report.Issue is null && m.Report.State is "ready" or "paused" or "playing");
        if (r.Playing && r.StartAt is long start && now >= start) { r.StartAt = null; r.Phase = "playing"; }
        var reconnecting = r.Members.Values.Any(m => now - m.SeenAt > 10_000 && now - m.SeenAt < 30_000);
        if (r.Playing && r.WaitForAll && (reconnecting || active.Any(m => (!m.Report.Ready || m.Report.State is "buffering" or "loading" or "error") && now - m.StateSince >= 1500)))
        { Freeze(r); r.WantsPlay = true; r.Phase = "waiting"; r.Version++; Event(r, "Waiting for participants to recover."); }
        if (r.WantsPlay && r.Queue.Count > 0 && allReady && (!r.WaitForAll || !reconnecting) && active.Length >= (r.HasStarted ? 1 : r.Minimum))
        { r.StartAt = now + 2500; r.Anchor = r.StartAt.Value; r.Playing = true; r.WantsPlay = false; r.HasStarted = true; r.Phase = "starting"; r.Version++; Event(r, "Everyone is ready. Shared start scheduled."); }
        r.UpdatedAt = now;
    }

    private FeatureRoomView View(Room r, Guid user, string session)
    {
        var now = _now();
        return new(r.Id, r.Name, now, r.Owner == user, r.HostOnly, r.WaitForAll, r.Minimum, r.AutoNext,
            new(r.Version, r.Generation, r.Position, r.Playing, r.Anchor, r.StartAt, r.NextAt, r.Phase, r.TargetRevision), r.Queue.FirstOrDefault()?.Media,
            r.Queue.Select(q => new FeatureQueueEntry(q.Id, q.Media, q.AddedBy, q.Votes.Count, q.Votes.Contains(user))).ToArray(),
            r.Members.Select(p => new FeatureMember(p.Key, p.Value.Name, p.Value.User == r.Owner, now - p.Value.SeenAt > 10_000 ? "disconnected" : p.Value.Report.State,
                p.Value.Report.Ready && p.Value.Report.Generation == r.Generation, now - p.Value.SeenAt <= 10_000, p.Value.SeenAt, p.Value.Report.PositionTicks,
                p.Value.Report.BufferTicks, p.Value.Report.Source, p.Value.Report.Issue, p.Value.Report.Preparation)).ToArray(), r.Messages.ToArray(), r.Events.ToArray());
    }

    private Room Require(string id) => _rooms.TryGetValue(id, out var r) ? r : throw new RoomAccessException(404, "Room not found.");
    private Room RequireMember(string id, Guid user, string session)
    { var r = Require(id); if (!r.Members.TryGetValue(session, out var m) || m.User != user) throw new RoomAccessException(403, "Join this room first."); return r; }
    private static void Host(Room r, Guid user) { if (r.Owner != user) throw new RoomAccessException(403, "Only the room host can do that."); }
    private Member[] Active(Room r) => r.Members.Values.Where(m => _now() - m.SeenAt <= 10_000).ToArray();
    private void JoinMember(Room r, Guid user, string session, string name)
    {
        foreach (var key in r.Members.Where(p => _now() - p.Value.SeenAt > 600_000).Select(p => p.Key).ToArray()) r.Members.Remove(key);
        if (!r.Members.ContainsKey(session) && r.Members.Count >= 32) throw new RoomAccessException(409, "This room is full.");
        r.Members[session] = new Member { User = user, Name = Text(name, 80), SeenAt = _now(), StateSince = _now() };
        Event(r, $"{r.Members[session].Name} joined.");
    }
    private void Event(Room r, string text) { r.Events.Add(new(Guid.NewGuid().ToString("N"), _now(), text)); if (r.Events.Count > 300) r.Events.RemoveAt(0); r.UpdatedAt = _now(); }
    private void Freeze(Room r) { r.Position = Position(r, _now()); r.Playing = false; r.StartAt = null; r.Anchor = _now(); }
    private static long Position(Room r, long now) => Math.Clamp(r.Position + (r.Playing ? Math.Max(0, now - r.Anchor) * 10_000 : 0), 0, 864_000_000_000);
    private static void InvalidateReady(Room r) { foreach (var m in r.Members.Values) m.Report = m.Report with { Ready = false }; }
    private void SelectCurrent(Room r)
    { r.Position = 0; r.Playing = false; r.WantsPlay = false; r.StartAt = null; r.NextAt = null; r.Anchor = _now(); r.Generation++; r.Version++; r.TargetRevision++; r.HasStarted = false; r.Phase = r.Queue.Count > 0 ? "preparing" : "idle"; InvalidateReady(r); }
    private static string Text(string? value, int max) { if (string.IsNullOrWhiteSpace(value) || value.Length > max || value.Any(char.IsControl)) throw new RoomAccessException(400, "Text is empty or too long."); return value.Trim(); }
    private static string? Short(string? value, int max) => string.IsNullOrWhiteSpace(value) ? null : new string(value.Where(c => !char.IsControl(c)).Take(max).ToArray());
    private void Save(bool force)
    {
        if (_path is null || (!force && _now() - _lastSaved < 10_000)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temp = _path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(_rooms.Values, JsonOptions)); File.Move(temp, _path, true); _lastSaved = _now();
    }

    public sealed class Room
    {
        public string Id { get; set; } = ""; public Guid Owner { get; set; } public string Name { get; set; } = "";
        public long UpdatedAt { get; set; } public long Position { get; set; } public long Anchor { get; set; }
        public long Version { get; set; } public long Generation { get; set; } public long TargetRevision { get; set; } public long? StartAt { get; set; } public long? NextAt { get; set; }
        public bool Playing { get; set; } public bool WantsPlay { get; set; } public bool HasStarted { get; set; }
        public string Phase { get; set; } = "idle"; public bool HostOnly { get; set; } public bool WaitForAll { get; set; } = true;
        public bool AutoNext { get; set; } = true; public int Minimum { get; set; } = 2;
        public List<QueueEntry> Queue { get; set; } = []; public List<FeatureMessage> Messages { get; set; } = []; public List<FeatureEvent> Events { get; set; } = [];
        [System.Text.Json.Serialization.JsonIgnore] public Dictionary<string, Member> Members { get; set; } = new();
    }
    public sealed class QueueEntry { public string Id { get; set; } = ""; public FeatureMedia Media { get; set; } = new("youtube", "", null, "", 0, ""); public string AddedBy { get; set; } = ""; public HashSet<Guid> Votes { get; set; } = []; }
    public sealed class Member { public Guid User { get; set; } public string Name { get; set; } = ""; public long SeenAt { get; set; } public long StateSince { get; set; } public long LastMessageAt { get; set; } public FeatureReport Report { get; set; } = new(0, "idle", false, 0, null, null, null, null, ""); }
}
