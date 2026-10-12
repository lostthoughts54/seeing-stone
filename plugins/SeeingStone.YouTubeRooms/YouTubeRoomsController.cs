using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace SeeingStone.YouTubeRooms;

public sealed record CreateRoomRequest(
    [property: System.Text.Json.Serialization.JsonPropertyName("clientId")] Guid ClientId,
    [property: System.Text.Json.Serialization.JsonPropertyName("name")] string? Name,
    [property: System.Text.Json.Serialization.JsonPropertyName("videoId")] string VideoId);
public sealed record JoinRoomRequest([property: System.Text.Json.Serialization.JsonPropertyName("clientId")] Guid ClientId);
public sealed record PresenceRequest(
    [property: System.Text.Json.Serialization.JsonPropertyName("clientId")] Guid ClientId,
    [property: System.Text.Json.Serialization.JsonPropertyName("status")] string Status);
public sealed record VideoRequest(
    [property: System.Text.Json.Serialization.JsonPropertyName("clientId")] Guid ClientId,
    [property: System.Text.Json.Serialization.JsonPropertyName("videoId")] string VideoId);
public sealed record QueueAddRequest(
    [property: System.Text.Json.Serialization.JsonPropertyName("clientId")] Guid ClientId,
    [property: System.Text.Json.Serialization.JsonPropertyName("videoIds")] IReadOnlyList<string> VideoIds,
    [property: System.Text.Json.Serialization.JsonPropertyName("playNow")] bool PlayNow);
public sealed record QueueActionRequest(
    [property: System.Text.Json.Serialization.JsonPropertyName("clientId")] Guid ClientId,
    [property: System.Text.Json.Serialization.JsonPropertyName("queueItemId")] string QueueItemId,
    [property: System.Text.Json.Serialization.JsonPropertyName("action")] string Action);
public sealed record AdvanceRequest(
    [property: System.Text.Json.Serialization.JsonPropertyName("clientId")] Guid ClientId,
    [property: System.Text.Json.Serialization.JsonPropertyName("expectedVideoId")] string ExpectedVideoId,
    [property: System.Text.Json.Serialization.JsonPropertyName("expectedQueueItemId")] string? ExpectedQueueItemId = null);
public sealed record HandoffRequest(
    [property: System.Text.Json.Serialization.JsonPropertyName("clientId")] Guid ClientId,
    [property: System.Text.Json.Serialization.JsonPropertyName("groupId")] string GroupId,
    [property: System.Text.Json.Serialization.JsonPropertyName("groupName")] string GroupName);
public sealed record ActionRequest(
    [property: System.Text.Json.Serialization.JsonPropertyName("clientId")] Guid ClientId,
    [property: System.Text.Json.Serialization.JsonPropertyName("action")] string Action,
    [property: System.Text.Json.Serialization.JsonPropertyName("positionSeconds")] double PositionSeconds);

[ApiController]
[Authorize]
[Route("SeeingStone/YouTubeRooms")]
public sealed class YouTubeRoomsController : ControllerBase
{
    private readonly YouTubeRoomStore _rooms;
    private readonly IAuthorizationContext _authorizationContext;

    public YouTubeRoomsController(YouTubeRoomStore rooms, IAuthorizationContext authorizationContext)
    {
        _rooms = rooms;
        _authorizationContext = authorizationContext;
    }

    [HttpGet]
    public ActionResult<object> Health() => Ok(new { protocolVersion = YouTubeRoomStore.ProtocolVersion, roomLifetimeMinutes = (int)YouTubeRoomStore.RoomLifetime.TotalMinutes });

    [HttpGet("open")]
    public ActionResult<IReadOnlyList<YouTubeRoomSummaryDto>> OpenRooms() => Ok(_rooms.ListOpenRooms());

    [HttpPost]
    public Task<ActionResult<YouTubeRoomDto>> Create([FromBody] CreateRoomRequest request) => ExecuteAsync(authorization => _rooms.Create(authorization.UserId, DisplayName(authorization), request.ClientId, request.Name, request.VideoId));

    [HttpPost("{token}/join")]
    public Task<ActionResult<YouTubeRoomDto>> Join([FromRoute] string token, [FromBody] JoinRoomRequest request) => ExecuteAsync(authorization => _rooms.Join(token, authorization.UserId, DisplayName(authorization), request.ClientId));

    [HttpPost("{token}/presence")]
    public Task<ActionResult<YouTubeRoomDto>> Presence([FromRoute] string token, [FromBody] PresenceRequest request) => ExecuteAsync(authorization => _rooms.Presence(token, authorization.UserId, DisplayName(authorization), request.ClientId, request.Status));

    [HttpPost("{token}/video")]
    public Task<ActionResult<YouTubeRoomDto>> SetVideo([FromRoute] string token, [FromBody] VideoRequest request) => ExecuteAsync(authorization => _rooms.SetVideo(token, authorization.UserId, request.ClientId, request.VideoId));

    [HttpPost("{token}/queue/add")]
    public Task<ActionResult<YouTubeRoomDto>> AddToQueue([FromRoute] string token, [FromBody] QueueAddRequest request) => ExecuteAsync(authorization => _rooms.AddToQueue(token, authorization.UserId, request.ClientId, request.VideoIds, request.PlayNow));

    [HttpPost("{token}/queue/action")]
    public Task<ActionResult<YouTubeRoomDto>> QueueAction([FromRoute] string token, [FromBody] QueueActionRequest request) => ExecuteAsync(authorization => _rooms.QueueAction(token, authorization.UserId, request.ClientId, request.QueueItemId, request.Action));

    [HttpPost("{token}/advance")]
    public Task<ActionResult<YouTubeRoomDto>> Advance([FromRoute] string token, [FromBody] AdvanceRequest request) => ExecuteAsync(authorization => _rooms.Advance(token, authorization.UserId, request.ClientId, request.ExpectedVideoId, request.ExpectedQueueItemId));

    [HttpPost("{token}/handoff")]
    public Task<ActionResult<YouTubeRoomDto>> Handoff([FromRoute] string token, [FromBody] HandoffRequest request) => ExecuteAsync(authorization => _rooms.Handoff(token, authorization.UserId, request.ClientId, request.GroupId, request.GroupName));

    [HttpPost("{token}/action")]
    public Task<ActionResult<YouTubeRoomDto>> Action([FromRoute] string token, [FromBody] ActionRequest request) => ExecuteAsync(authorization => _rooms.ApplyAction(token, authorization.UserId, request.ClientId, request.Action, request.PositionSeconds));

    [HttpPost("{token}/leave")]
    public async Task<ActionResult> Leave([FromRoute] string token, [FromBody] JoinRoomRequest request)
    {
        try { _rooms.Leave(token, (await CurrentAuthorizationAsync().ConfigureAwait(false)).UserId, request.ClientId); return NoContent(); }
        catch (RoomAccessException error) { return StatusCode(error.StatusCode, new { error = error.Message }); }
    }

    private async Task<ActionResult<YouTubeRoomDto>> ExecuteAsync(Func<AuthorizationInfo, YouTubeRoomDto> operation)
    {
        try { return Ok(operation(await CurrentAuthorizationAsync().ConfigureAwait(false))); }
        catch (RoomAccessException error) { return StatusCode(error.StatusCode, new { error = error.Message }); }
    }

    private async Task<AuthorizationInfo> CurrentAuthorizationAsync()
    {
        var authorization = await _authorizationContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        if (!authorization.IsAuthenticated || authorization.UserId == Guid.Empty)
            throw new RoomAccessException(StatusCodes.Status401Unauthorized, "A Jellyfin user session is required.");
        return authorization;
    }

    private string DisplayName(AuthorizationInfo authorization)
    {
        var displayName = authorization.User?.Username ?? User.Identity?.Name ?? "Jellyfin user";
        return displayName.Length <= 256 ? displayName : displayName[..256];
    }
}
