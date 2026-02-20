using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos; // 确保引用了 DTO 命名空间
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;

namespace FsusBlog.Server.Controllers;

/// <summary>
/// 身份认证控制器：负责注册、登录、会话维护与安全退出
/// </summary>
[Route("api/[controller]")]
[ApiController]
public class AuthController(
    IUserService _userService,
    ILogger<AuthController> _logger,
    IWebHostEnvironment _env,
    AdaptivePowGovernor _governor,
    IPowService _powService) : ControllerBase
{

    /// <summary>
    /// 获取 PoW 挑战的接口（下发牌器）
    /// </summary>
    [EnableRateLimiting("fixed_ip")]
    [HttpGet("pow-challenge")]
    [AllowAnonymous]
    public async Task<ActionResult<PowChallenge>> GetChallenge()
    {
        string clientIp = HttpContext.GetClientIp();

        // 修改点：异步调用，支持动态难度
        var challenge = await _powService.GenerateChallengeAsync(clientIp);

        return Ok(challenge);
    }

    // ================= 1. 准入逻辑 (Register / Login) =================

    [EnableRateLimiting("fixed_ip")]
    [AllowAnonymous]
    [HttpPost("register")]
    public async Task<ActionResult<ApiResponse>> Register([FromBody] RegisterDto dto)
    {
        // 1. 静态自校验 (无需任何计算)
        if (!ModelState.IsValid)
            return BadRequest(ApiResponse.Fail("提交的数据模型不完整"));

        // 2. 逻辑自校验 (内存级操作)
        if (dto.Password != dto.ConfirmPassword)
            return BadRequest(ApiResponse.Fail("两次输入的密码不一致", 400));

        // 3. 环境自校验 (获取上下文元数据)
        string clientIp = HttpContext.GetClientIp();

        // 关键自对照点：BrowserFp 必须参与哈希拼接
        if (string.IsNullOrWhiteSpace(dto.BrowserFp))
            return BadRequest(ApiResponse.Fail("环境安全检测异常 (Fingerprint Missing)", 400));

        // 4. 实时环境裁决 (熔断逻辑)
        // 职责：在消耗昂贵的 PoW 验证计算资源前，先拦截低难度的请求
        // 性能最大化：GetDifficultyForIpAsync 通常命中内存缓存，速度极快
        int currentRequired = await _governor.GetDifficultyForIpAsync(clientIp);

        // 如果提交的难度低于当前服务器要求的难度，直接拒绝 (HTTP 403)
        // 这迫使客户端重新获取挑战，从而遵守当前的流控策略
        if (dto.Difficulty < currentRequired)
        {
            return StatusCode(403, ApiResponse.Fail("当前注册通道拥堵，请刷新以提升算力", 403));
        }

        // 5. 核心算力与安全自校验
        // 逻辑：如果校验不通过，直接返回 401
        if (!await _powService.VerifyAsync(dto, clientIp))
        {
            // 流量统计已由 ShieldMiddleware 在管道前端统一处理
            return StatusCode(401, ApiResponse.Fail("安全校验未通过或已失效，请重试", 401));
        }

        // 6. 业务逻辑自校验 (数据库 IO)
        var (success, message) = await _userService.RegisterAsync(dto);

        if (!success)
        {
            return BadRequest(ApiResponse.Fail(message, 400));
        }

        return Ok(ApiResponse.Success("注册成功"));
    }

    [EnableRateLimiting("fixed_ip")]
    [AllowAnonymous]
    [HttpPost("login")]
    public async Task<ActionResult<ApiResponse<object>>> Login([FromBody] LoginDto dto)
    {
        if (dto == null || string.IsNullOrWhiteSpace(dto.Username) || string.IsNullOrWhiteSpace(dto.Password))
            return BadRequest(ApiResponse.Fail("用户名或密码不能为空"));

        string clientIp = HttpContext.GetClientIp();

        // 1. 实时环境裁决 (熔断逻辑)
        // 确保登录接口同样受到动态难度的保护，防止撞库攻击绕过高防模式
        int currentRequired = await _governor.GetDifficultyForIpAsync(clientIp);

        if (dto.Difficulty < currentRequired)
        {
            return StatusCode(403, ApiResponse.Fail("当前登录通道拥堵，请刷新以提升算力", 403));
        }

        // 2. 核心算力与安全自校验
        if (!await _powService.VerifyAsync(dto, clientIp))
        {
            return StatusCode(401, ApiResponse.Fail("安全校验已失效，请重试", 401));
        }

        // 3. 业务执行
        var (success, message, token, userEntity) = await _userService.LoginAsync(dto, clientIp);

        if (!success || token == null || userEntity == null)
        {
            return Unauthorized(ApiResponse.Fail(message, 401));
        }

        // 解析 Token 以获取 Role
        var handler = new JwtSecurityTokenHandler();
        var jwtToken = handler.ReadJwtToken(token.AccessToken);
        var roleStr = jwtToken.Claims.FirstOrDefault(c => c.Type == ClaimTypes.Role || c.Type == "role")?.Value;

        SetTokenCookies(token.AccessToken, token.RefreshToken);

        _logger.LogInformation("登录成功：用户 {Username} | 状态: {Status}", dto.Username, userEntity.Status);

        return Ok(ApiResponse<object>.Success(new
        {
            id = userEntity.Id,
            username = userEntity.Username,
            role = roleStr?.ToLower() ?? "user",
            status = userEntity.Status,       // 0:正常, 1:受限
            banReason = userEntity.BanReason  // 告知用户理由
        }));
    }

    // ================= 2. 用户状态查询 (Info) =================

    [Authorize]
    [HttpGet("me")]
    public async Task<ActionResult<ApiResponse<object>>> GetCurrentUserInfo()
    {
        var userId = User.GetUserId(); // 假设这是你的扩展方法
        var user = await _userService.GetByIdAsync(userId);

        if (user == null) return NotFound(ApiResponse.Fail("用户不存在", 404));

        return Ok(ApiResponse<object>.Success(new { user.Id, user.Username, user.Role }));
    }

    [Authorize(Roles = "admin")]
    [HttpGet("{id}")]
    public async Task<ActionResult<ApiResponse<object>>> GetUserInfo(int id)
    {
        var user = await _userService.GetByIdAsync(id);
        if (user == null) return NotFound(ApiResponse.Fail("未找到该用户", 404));

        return Ok(ApiResponse<object>.Success(new { user.Id, user.Username, user.Role }));
    }

    // ================= 3. 会话变更 (Update / Refresh) =================

    [EnableRateLimiting("fixed_ip")]
    [Authorize]
    [HttpPut("update-username")]
    public async Task<ActionResult<ApiResponse>> UpdateUsername([FromBody] UpdateUsernameDto dto)
    {
        var userId = User.GetUserId();
        var (success, message, newToken) = await _userService.UpdateUsernameAsync(userId, dto.NewUsername);

        if (!success || newToken == null) return BadRequest(ApiResponse.Fail(message));

        // 用户名变更后必须重新下发身份 Cookie
        SetTokenCookies(newToken.AccessToken, newToken.RefreshToken);

        return Ok(ApiResponse.Success("用户名修改成功"));
    }

    [EnableRateLimiting("fixed_ip")]
    [Authorize]
    [HttpPut("update-password")]
    public async Task<ActionResult<ApiResponse>> UpdatePassword([FromBody] UpdatePasswordDto dto)
    {
        var userId = User.GetUserId();

        // PoW 校验 (前置防御)
        // 修改密码属于高危操作，必须校验算力
        string clientIp = HttpContext.GetClientIp();

        // 1.1 熔断检查
        int currentRequired = await _governor.GetDifficultyForIpAsync(clientIp);
        if (dto.Difficulty < currentRequired)
        {
            return StatusCode(403, ApiResponse.Fail("当前网络环境不稳定，请重试以提升安全等级", 403));
        }

        // 1.2 签名校验
        if (!await _powService.VerifyAsync(dto, clientIp))
        {
            return StatusCode(401, ApiResponse.Fail("安全校验失败：凭证无效或过期", 401));
        }

        // 2. 业务逻辑
        var (success, message) = await _userService.UpdatePasswordAsync(userId, dto);

        if (!success) return BadRequest(ApiResponse.Fail(message));

        // 改密后清除全端 Cookie
        ClearTokenCookies();

        _logger.LogWarning("安全事件：用户 {Id} 修改密码，已销毁所有在线会话 | IP: {IP}", userId, clientIp);
        return Ok(ApiResponse.Success("密码修改成功，请重新登录"));
    }

    [EnableRateLimiting("fixed_ip")]
    [AllowAnonymous]
    [HttpPost("refresh-token")]
    public async Task<ActionResult<ApiResponse>> RefreshToken()
    {
        var oldRefreshToken = Request.Cookies["RefreshToken"];
        if (string.IsNullOrEmpty(oldRefreshToken))
            return Unauthorized(ApiResponse.Fail("会话已失效，请重新登录", 401));

        var (success, newTokens) = await _userService.RefreshTokenAsync(oldRefreshToken);

        if (!success || newTokens == null)
        {
            ClearTokenCookies();
            return Unauthorized(ApiResponse.Fail("刷新凭证已失效", 401));
        }

        SetTokenCookies(newTokens.AccessToken, newTokens.RefreshToken);
        return Ok(ApiResponse.Success("Token 已刷新"));
    }

    [Authorize]
    [HttpPost("logout")]
    public async Task<ActionResult<ApiResponse>> Logout()
    {
        var refreshToken = Request.Cookies["RefreshToken"];
        if (!string.IsNullOrEmpty(refreshToken))
        {
            await _userService.RevokeRefreshTokenAsync(refreshToken);
        }

        ClearTokenCookies();
        return Ok(ApiResponse.Success("安全退出成功"));
    }

    // ================= 5. 私有逻辑封装 (Private) =================

    private void SetTokenCookies(string access, string refresh)
    {
        var isProd = !_env.IsDevelopment();

        var baseOptions = new CookieOptions
        {
            HttpOnly = true,
            Secure = isProd, // 开发环境允许 HTTP
            SameSite = SameSiteMode.Strict,
            Path = "/"
        };

        // 短效 AccessToken (15min)
        Response.Cookies.Append("AccessToken", access, new CookieOptions
        {
            HttpOnly = baseOptions.HttpOnly,
            Secure = baseOptions.Secure,
            SameSite = baseOptions.SameSite,
            Path = baseOptions.Path,
            Expires = DateTime.UtcNow.AddMinutes(15)
        });

        // 长效 RefreshToken (7d)
        Response.Cookies.Append("RefreshToken", refresh, new CookieOptions
        {
            HttpOnly = baseOptions.HttpOnly,
            Secure = baseOptions.Secure,
            SameSite = baseOptions.SameSite,
            Path = baseOptions.Path,
            Expires = DateTime.UtcNow.AddDays(7)
        });
    }

    private void ClearTokenCookies()
    {
        Response.Cookies.Delete("AccessToken");
        Response.Cookies.Delete("RefreshToken");
    }
}