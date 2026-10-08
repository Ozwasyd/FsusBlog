using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

static class Probe
{
    static string Hash(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    static string Tokens(SyntaxNode node) => JsonSerializer.Serialize(node.DescendantTokens(descendIntoTrivia: false).Select(t => new { kind=t.RawKind, t.Text, t.ValueText }));
    static string Ast(SyntaxNode node) => JsonSerializer.Serialize(node.DescendantNodesAndTokensAndSelf().Select(n => n.IsNode ? $"N:{n.RawKind}" : $"T:{n.RawKind}:{n.AsToken().Text}"));
    static string StripXml(string text) => string.Concat(text.Split('\n').Select((line,i) => line.TrimStart().StartsWith("///",StringComparison.Ordinal) ? "" : line+(i<text.Split('\n').Length-1 ? "\n" : "")));
    static string Signature(MemberDeclarationSyntax node) => string.Join(" ",node.DescendantTokens(descendIntoTrivia:false).TakeWhile(t=>!t.IsKind(SyntaxKind.OpenBraceToken)&&!t.IsKind(SyntaxKind.EqualsGreaterThanToken)).Select(t=>t.Text));
    static string Summary(MemberDeclarationSyntax node) => string.Join(" ",node.GetLeadingTrivia().Select(t=>t.GetStructure()).OfType<DocumentationCommentTriviaSyntax>().SelectMany(d=>d.DescendantNodes().OfType<XmlElementSyntax>()).Where(e=>e.StartTag.Name.LocalName.ValueText=="summary").Select(e=>string.Join(" ",e.DescendantTokens().Where(t=>t.IsKind(SyntaxKind.XmlTextLiteralToken)).Select(t=>t.ValueText.Trim()))));
    public static int Main(string[] args)
    {
        var paths=args.Take(3).ToArray();var sources=paths.Select(File.ReadAllText).ToArray();var trees=sources.Select(s=>CSharpSyntaxTree.ParseText(s,new CSharpParseOptions(LanguageVersion.CSharp14,DocumentationMode.Diagnose))).ToArray();
        var originalMembers=trees[0].GetRoot().DescendantNodes().OfType<MemberDeclarationSyntax>().ToArray();
        var members=trees[2].GetRoot().DescendantNodes().OfType<MemberDeclarationSyntax>().ToArray();
        using var roster=JsonDocument.Parse(File.ReadAllText(args[3]));var rows=new List<object>();bool complete=true;
        foreach(var row in roster.RootElement.GetProperty("declarations").EnumerateArray())
        {
            int line=row.GetProperty("line").GetInt32();var original=originalMembers.Single(n=>n.GetLocation().GetLineSpan().StartLinePosition.Line+1==line);
            string key=Tokens(original);var match=members.Where(n=>Tokens(n)==key).ToArray();bool unique=match.Length==1;var current=unique?match[0]:null;string summary=current is null?"":Summary(current);bool documented=!string.IsNullOrWhiteSpace(summary);complete&=unique&&documented;
            rows.Add(new{originalLine=line,kind=original.Kind().ToString(),signature=Signature(original),originalMemberTokenSha256=Hash(key),currentLine=current is null?0:current.GetLocation().GetLineSpan().StartLinePosition.Line+1,uniqueCompleteTokenMatch=unique,signatureEqual=current is not null&&Signature(original)==Signature(current),meaningfulXmlSummaryPresent=documented,summary});
        }
        var tokenMutation=CSharpSyntaxTree.ParseText(sources[2].Replace("Interlocked.CompareExchange(ref location, value, current)","Interlocked.CompareExchange(ref location, current, value)"));
        var malformed=CSharpSyntaxTree.ParseText(sources[2].Replace("</summary>","</broken>"),new CSharpParseOptions(LanguageVersion.CSharp14,DocumentationMode.Diagnose));
        bool tokens=trees.All(t=>Tokens(t.GetRoot())==Tokens(trees[0].GetRoot()));bool ast=trees.All(t=>Ast(t.GetRoot())==Ast(trees[0].GetRoot()));bool stripped=sources.All(s=>StripXml(s)==StripXml(sources[0]));bool syntax=trees.All(t=>!t.GetDiagnostics().Any());bool negativeTokens=Tokens(tokenMutation.GetRoot())!=Tokens(trees[2].GetRoot());bool negativeXml=malformed.GetDiagnostics().Any();
        var report=new{schema="fsusblog.ban-projection-contract-source-proof.v1",scope="original/base/head source proof; not independent review/runtime qualification",inputs=paths.Select((path,i)=>new{path,sha256=Hash(sources[i]),completeNoncommentTokenSha256=Hash(Tokens(trees[i].GetRoot())),completeAstSha256=Hash(Ast(trees[i].GetRoot())),xmlStrippedByteSha256=Hash(StripXml(sources[i])),diagnostics=trees[i].GetDiagnostics().Select(d=>d.ToString()).ToArray()}),completeNoncommentTokensEqual=tokens,completeAstEqual=ast,xmlStrippedBytesEqual=stripped,allSignaturesPreserved=tokens&&rows.Count==17&&complete,exactOriginalRosterCount=rows.Count,exact17Covered=rows.Count==17&&complete,allCurrentSummaryDeclarations=members.Count(n=>!string.IsNullOrWhiteSpace(Summary(n))),negativeTokenMutationRejected=negativeTokens,negativeMalformedXmlRejected=negativeXml,coverage=rows};
        Console.WriteLine(JsonSerializer.Serialize(report,new JsonSerializerOptions{WriteIndented=true}));return syntax&&tokens&&ast&&stripped&&complete&&rows.Count==17&&negativeTokens&&negativeXml?0:1;
    }
}
