global using FsusBlog.Shared.Contracts.Security;
global using FsusBlog.Core.Cache;
global using FsusBlog.Server.Entities;
global using FsusBlog.Server.Infrastructure.Auth;
global using FsusBlog.Server.Infrastructure.Helpers;
global using FsusBlog.Server.Interfaces;
global using FsusBlog.Server.Services;
global using FsusBlog.Server.Services.Security;
global using FsusBlog.Server.Tests.TestInfrastructure;
global using FsusBlog.Shared.Contracts.Governance;
global using FsusBlog.Shared.Contracts.Models;
global using FsusBlog.Shared.Contracts.Outputs;
global using FsusBlog.Shared.Contracts.Validation;

global using Microsoft.AspNetCore.Builder;
global using Microsoft.AspNetCore.Http;
global using Microsoft.AspNetCore.Routing;
global using Microsoft.Extensions.DependencyInjection;

global using Xunit;

global using AedsFrameHeader = FsusBlog.Shared.AedsFrameHeader;
global using IArticleService = FsusBlog.Core.Services.Abstractions.IArticleCoreService;
