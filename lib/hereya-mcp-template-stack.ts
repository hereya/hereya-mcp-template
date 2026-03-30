import * as cdk from 'aws-cdk-lib/core';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';

export class HereyaMcpTemplateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Parameters from hereya (common)
    const projectName = process.env['projectName'] as string;
    const workspace = process.env['workspace'] as string;
    const deployWorkspace = process.env['deployWorkspace'] || '';

    // Template-specific parameters
    const organizationId = process.env['organizationId'] || '';
    const customDomain = process.env['customDomain'] || '';

    // Optional: existing IAM/CodeCommit credentials (skip IAM user creation when provided)
    const existingIamUserName = process.env['hereyaCodecommitIamUserName'];
    const existingIamUserArn = process.env['hereyaCodecommitUserArn'];
    const existingGitUsername = process.env['hereyaCodecommitUsername'];
    const existingGitPassword = process.env['hereyaCodecommitPassword'];
    const useExistingUser = !!(existingIamUserName || existingIamUserArn);

    // Sanitize: projectName may contain org prefix (e.g. "hereya/myapp" → "hereya-myapp")
    const safeName = projectName.replaceAll('/', '-');

    // ── Upload template directory as S3 asset ──
    // Local bundling copies template files and injects parameters (no Docker needed)
    const templateAsset = new Asset(this, 'TemplateAsset', {
      path: path.join(__dirname, '..', 'template'),
      bundling: {
        image: cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/node:20-slim'),
        local: {
          tryBundle(outputDir: string): boolean {
            const templateDir = path.join(__dirname, '..', 'template');
            copyDirSync(templateDir, outputDir);

            // Inject project/workspace into hereya.yaml
            const hereyaYamlPath = path.join(outputDir, 'hereya.yaml');
            const existing = fs.existsSync(hereyaYamlPath) ? fs.readFileSync(hereyaYamlPath, 'utf-8') : '';
            fs.writeFileSync(
              hereyaYamlPath,
              existing.trimEnd() + `\nproject: ${projectName}\nworkspace: ${workspace}\n`,
            );

            // Inject organizationId and customDomain into hereyaconfig/hereyavars/aws--mcp-lambda.yaml
            const mcpLambdaVarsPath = path.join(outputDir, 'hereyaconfig', 'hereyavars', 'aws--mcp-lambda.yaml');
            fs.mkdirSync(path.dirname(mcpLambdaVarsPath), { recursive: true });
            fs.writeFileSync(mcpLambdaVarsPath, [
              '---',
              'profile: staging',
              `customDomain: ${customDomain}`,
              'oauthServerUrl: https://cloud.hereya.dev',
              `organizationId: ${organizationId}`,
              '',
            ].join('\n'));

            // Inject deployWorkspace into CLAUDE.md
            const claudeMdPath = path.join(outputDir, 'CLAUDE.md');
            if (fs.existsSync(claudeMdPath)) {
              let claudeContent = fs.readFileSync(claudeMdPath, 'utf-8');
              claudeContent = claudeContent.replaceAll('{{deployWorkspace}}', deployWorkspace);
              fs.writeFileSync(claudeMdPath, claudeContent);
            }

            return true;
          },
        },
      },
    });

    // ── CodeCommit Repository with initial code ──
    new codecommit.CfnRepository(this, 'Repo', {
      repositoryName: safeName,
      repositoryDescription: `MCP server for ${projectName}`,
      code: {
        branchName: 'main',
        s3: {
          bucket: templateAsset.s3BucketName,
          key: templateAsset.s3ObjectKey,
        },
      },
    });

    // ── IAM and Git credentials ──
    let gitUsername = '';
    let gitPasswordSecretArn = '';

    if (useExistingUser) {
      // Reference the existing IAM user and add a policy granting access to the new repo
      const existingUser = existingIamUserArn
        ? iam.User.fromUserArn(this, 'ExistingGitUser', existingIamUserArn)
        : iam.User.fromUserName(this, 'ExistingGitUser', existingIamUserName!);

      const codecommitPolicy = new iam.Policy(this, 'CodeCommitPolicy', {
        policyName: `${safeName}-codecommit-policy`,
        statements: [
          new iam.PolicyStatement({
            actions: ['codecommit:GitPull', 'codecommit:GitPush'],
            resources: [cdk.Arn.format({ service: 'codecommit', resource: safeName }, this)],
          }),
        ],
      });
      existingUser.attachInlinePolicy(codecommitPolicy);

      gitUsername = existingGitUsername || '';

      // Store the provided password in Secrets Manager so Hereya can resolve it via ARN
      const gitPasswordSecret = new secretsmanager.Secret(this, 'GitPasswordSecret', {
        secretName: `${safeName}/git-password`,
        description: `CodeCommit Git password for ${safeName}`,
        secretStringValue: cdk.SecretValue.unsafePlainText(existingGitPassword || ''),
      });
      gitPasswordSecretArn = gitPasswordSecret.secretArn;
    } else {
      // Create a new IAM user with CodeCommit access and generate service-specific credentials
      const gitUser = new iam.User(this, 'GitUser', {
        userName: `${safeName}-git-user`,
      });

      gitUser.addToPolicy(
        new iam.PolicyStatement({
          actions: ['codecommit:GitPull', 'codecommit:GitPush'],
          resources: [cdk.Arn.format({ service: 'codecommit', resource: safeName }, this)],
        }),
      );

      const gitCredential = new cr.AwsCustomResource(this, 'GitCredential', {
        onCreate: {
          service: 'IAM',
          action: 'createServiceSpecificCredential',
          parameters: {
            UserName: gitUser.userName,
            ServiceName: 'codecommit.amazonaws.com',
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse(
            'ServiceSpecificCredential.ServiceSpecificCredentialId',
          ),
        },
        onDelete: {
          service: 'IAM',
          action: 'deleteServiceSpecificCredential',
          parameters: {
            UserName: gitUser.userName,
            ServiceSpecificCredentialId: new cr.PhysicalResourceIdReference(),
          },
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: [
              'iam:CreateServiceSpecificCredential',
              'iam:DeleteServiceSpecificCredential',
            ],
            resources: [gitUser.userArn],
          }),
        ]),
      });
      gitCredential.node.addDependency(gitUser);

      gitUsername = gitCredential.getResponseField('ServiceSpecificCredential.ServiceUserName');
      const gitPasswordValue = gitCredential.getResponseField('ServiceSpecificCredential.ServicePassword');

      const gitPasswordSecret = new secretsmanager.Secret(this, 'GitPasswordSecret', {
        secretName: `${safeName}/git-password`,
        description: `CodeCommit Git password for ${safeName}`,
        secretStringValue: cdk.SecretValue.unsafePlainText(gitPasswordValue),
      });
      gitPasswordSecretArn = gitPasswordSecret.secretArn;
    }

    // ── Outputs ──
    new cdk.CfnOutput(this, 'hereyaGitRemoteUrl', {
      value: `https://git-codecommit.${this.region}.amazonaws.com/v1/repos/${safeName}`,
      description: 'CodeCommit HTTPS clone URL',
    });

    new cdk.CfnOutput(this, 'hereyaGitUsername', {
      value: gitUsername,
      description: 'CodeCommit Git HTTPS username',
    });

    new cdk.CfnOutput(this, 'hereyaGitPassword', {
      value: gitPasswordSecretArn,
      description: 'Secrets Manager ARN for CodeCommit Git password (auto-resolved by Hereya)',
    });
  }
}

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
