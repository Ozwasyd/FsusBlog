import assert from 'node:assert/strict';
import test from 'node:test';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { verifyCentralOpenApiPackageContract } from '../../tools/backend-test-governance-contracts.mjs';

const validCentralPackages = `
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.AspNetCore.OpenApi" Version="10.0.9" />
  </ItemGroup>
</Project>`;

const validServerProject = `
<Project>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" GeneratePathProperty="true" />
  </ItemGroup>
</Project>`;

function verify(centralPackages = validCentralPackages, serverProject = validServerProject)
{
    return verifyCentralOpenApiPackageContract(centralPackages, serverProject);
}

test('accepts the exact central OpenAPI version and project path property', () =>
{
    assert.deepEqual(verify(), []);
});

test('rejects a missing central OpenAPI entry', () =>
{
    assert.match(verify('<Project />').join('\n'), /exactly one Microsoft\.AspNetCore\.OpenApi PackageVersion/u);
});

test('rejects the wrong central OpenAPI version', () =>
{
    assert.match(
        verify(validCentralPackages.replace('10.0.9', '10.0.8')).join('\n'),
        /bind Microsoft\.AspNetCore\.OpenApi exactly to 10\.0\.9/u
    );
});

test('rejects duplicate central OpenAPI entries', () =>
{
    const duplicate = validCentralPackages.replace(
        '</ItemGroup>',
        '    <PackageVersion Include="Microsoft.AspNetCore.OpenApi" Version="10.0.9" />\n  </ItemGroup>'
    );
    assert.match(verify(duplicate).join('\n'), /exactly one Microsoft\.AspNetCore\.OpenApi PackageVersion/u);
});

test('rejects a central OpenAPI Update override', () =>
{
    const update = validCentralPackages.replace(
        '</ItemGroup>',
        '    <PackageVersion Update="Microsoft.AspNetCore.OpenApi" Version="10.0.8" />\n  </ItemGroup>'
    );
    assert.match(verify(update).join('\n'), /exactly one Microsoft\.AspNetCore\.OpenApi PackageVersion/u);
});

test('rejects central VersionOverride metadata', () =>
{
    const central = validCentralPackages.replace('Version="10.0.9"', 'Version="10.0.9" VersionOverride="10.0.8"');
    assert.match(verify(central).join('\n'), /bind Microsoft\.AspNetCore\.OpenApi exactly to 10\.0\.9/u);
});

test('rejects a central child Version authority', () =>
{
    const central = validCentralPackages.replace(
        '<PackageVersion Include="Microsoft.AspNetCore.OpenApi" Version="10.0.9" />',
        '<PackageVersion Include="Microsoft.AspNetCore.OpenApi" Version="10.0.9"><Version>10.0.8</Version></PackageVersion>'
    );
    assert.match(verify(central).join('\n'), /bind Microsoft\.AspNetCore\.OpenApi exactly to 10\.0\.9/u);
});

for (const inlineVersion of [
    'Version="10.0.9"',
    'VersionOverride="10.0.9"'
])
{
    test(`rejects project-local ${inlineVersion.split('=')[0]}`, () =>
    {
        const project = validServerProject.replace('GeneratePathProperty', `${inlineVersion} GeneratePathProperty`);
        assert.match(verify(validCentralPackages, project).join('\n'), /must not declare inline Version or VersionOverride/u);
    });
}

test('rejects a project OpenAPI Update override', () =>
{
    const update = validServerProject.replace(
        '</ItemGroup>',
        '    <PackageReference Update="Microsoft.AspNetCore.OpenApi" VersionOverride="10.0.8" />\n  </ItemGroup>'
    );
    assert.match(verify(validCentralPackages, update).join('\n'), /exactly one Microsoft\.AspNetCore\.OpenApi PackageReference/u);
});

for (const childName of ['Version', 'VersionOverride'])
{
    test(`rejects project-local child ${childName}`, () =>
    {
        const project = validServerProject.replace(
            '<PackageReference Include="Microsoft.AspNetCore.OpenApi" GeneratePathProperty="true" />',
            `<PackageReference Include="Microsoft.AspNetCore.OpenApi" GeneratePathProperty="true"><${childName}>10.0.8</${childName}></PackageReference>`
        );
        assert.match(verify(validCentralPackages, project).join('\n'), /must not declare inline Version or VersionOverride/u);
    });
}

test('rejects a missing GeneratePathProperty', () =>
{
    const project = validServerProject.replace(' GeneratePathProperty="true"', '');
    assert.match(verify(validCentralPackages, project).join('\n'), /set GeneratePathProperty exactly to true/u);
});

test('rejects a wrong GeneratePathProperty', () =>
{
    const project = validServerProject.replace('GeneratePathProperty="true"', 'GeneratePathProperty="false"');
    assert.match(verify(validCentralPackages, project).join('\n'), /set GeneratePathProperty exactly to true/u);
});
