using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace SeeingStone.YouTubeRooms;

public sealed record CreateRoomRequest(Guid ClientId, string VideoId);
public sealed record JoinRoomRequest(Guid ClientId);
public sealed record PresenceRequest(Guid ClientId, string Status);
public sealed record VideoRequest(Guid ClientId, string VideoId);
public sealed record ActionRequest(Guid ClientId, string Action, double PositionSeconds);

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

    [HttpPost]
    public Task<ActionResult<YouTubeRoomDto>> Create([FromBody] CreateRoomRequest request) => ExecuteAsync(authorization => _rooms.Create(authorization.UserId, DisplayName(authorization), request.ClientId, request.VideoId));

    [HttpPost("{token}/join")]
    public Task<ActionResult<YouTubeRoomDto>> Join([FromRoute] string token, [FromBody] JoinRoomRequest request) => ExecuteAsync(authorization => _rooms.Join(token, authorization.UserId, DisplayName(authorization), request.ClientId));

    [HttpPost("{token}/presence")]
    public Task<ActionResult<YouTubeRoomDto>> Presence([FromRoute] string token, [FromBody] PresenceRequest request) => ExecuteAsync(authorization => _rooms.Presence(token, authorization.UserId, DisplayName(authorization), request.ClientId, request.Status));

    [HttpPost("{token}/video")]
    public Task<ActionResult<YouTubeRoomDto>> SetVideo([FromRoute] string token, [FromBody] VideoRequest request) => ExecuteAsync(authorization => _rooms.SetVideo(token, authorization.UserId, request.ClientId, request.VideoId));

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
