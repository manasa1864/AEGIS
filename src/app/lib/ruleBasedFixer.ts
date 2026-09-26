// Orchestrator — applies all rule-based fixers before falling back to AI.
//
// COMPOSITION MODEL: applyRuleBasedFixes threads files sequentially so that
// multiple rules on the same file compose correctly — each rule sees the
// previous rule's output, not the original file.
//
// FILE ORGANIZATION:
//   Simple       → fixers/simple/{syntax,environment,dependencies,build}
//   Intermediate → fixers/intermediate/{git,pipeline,config,runtime,testing}
//   Advanced     → fixers/advanced/{auth,docker,deployment,api,database}
//   Code         → fixers/code/source (surgical edits to application source)

import type { ErrorCategory } from './diagnostics';

// Re-export RuleFix from helpers for backward compatibility
export type { RuleFix } from './fixers/helpers';
import type { RuleFix } from './fixers/helpers';

// ── Simple ───────────────────────────────────────────────────────────────────
import {
  fixYamlTabIndentation, fixYamlIndentationDepth, fixMissingWorkflowTrigger, fixWorkflowTriggerTypo,
  fixAptGetSudo, fixMissingShebang, fixStepUsesAndRun, fixDuplicateYamlKey,
  fixChmodScript, fixShallowCloneFetchDepth,
  fixWindowsCommandsOnLinux, fixLinuxCommandsOnWindows, fixBashSyntaxInPosixSh,
  fixIncorrectFilePath, fixMissingYamlColon, fixIncorrectYamlBooleans,
  fixIncorrectExpressionDelimiter,
  fixInvalidJsonSyntax, fixScriptTypo, fixIncorrectVariableName,
  fixRunnerLabelTypo, fixMissingCheckoutStep, fixInvalidCronExpression,
  fixGitLabOnlyExceptToRules, fixMultilineRunScript, fixMissingWorkflowCallTrigger,
} from './fixers/simple/syntax';

import {
  fixCreateDotEnvExample, fixMissingNodeEnv, fixOptionalSecretSteps,
  fixEnvVarWithDefault, fixGitLabMissingVariables, fixPromoteRepeatedEnvVars,
  fixMissingCIEnvFlag, fixVariableScopeIssue,
  fixHardcodedSecretInYaml, fixTerraformEnvVars, fixDockerBuildArgEnvVars,
  fixDeprecatedSaveState, fixMissingGitHubTokenPermissions, fixGitLabVariableMasking,
  fixAddDebugFlags,
  // new — env vars
  fixMissingAwsRegion, fixPythonEnvVars, fixJavaEnvVars, fixGoEnvVars, fixCargoEnvVars,
  fixDotNetEnvVars, fixRubyEnvVars, fixPhpEnvVars, fixGoogleCloudEnvVars, fixAzureEnvVars,
  fixVercelDeployEnvVars, fixSentryEnvVars,
  // new — secrets
  fixUndeclaredEnvVarReference, fixDotEnvInGitignore,
  fixMissingNpmPublishToken, fixMissingDockerRegistrySecrets,
  fixMissingSecretsContextUsage,
  // new — values / scope
  fixIncorrectNodeEnvValue, fixStepOutputScopeError,
  fixMissingJobOutputsDeclaration, fixEventInputScope,
  fixSecretsInheritance, fixExportVarCrossStep,
} from './fixers/simple/environment';

import {
  // missing package/module
  fixAddInstallStep, fixMissingYarnInstallStep, fixMissingPnpmSetup,
  fixMissingComposerInstall, fixMissingPoetryInstall, fixMissingPipenvInstall,
  fixMissingSetupPython, fixMissingSetupJava, fixMissingSetupGo,
  fixCreateRequirementsTxt, fixMissingVirtualEnv, fixPoetryVirtualEnv,
  fixCondaEnvironmentSetup, fixGoModDownload, fixRubyBundlerSetup,
  // version mismatch
  fixNodeVersionPin, fixUnsupportedEngineVersion, fixPythonVersionPin,
  fixJavaVersionPin, fixGoVersionPin, fixRubyVersionPin,
  fixNpmEnginesCheck, fixNvmrcVersionMismatch, fixPipUpgrade,
  // dependency conflict
  fixPeerDepConflict, fixNpmOverrides, fixYarnResolutions,
  fixYarnFrozenLockfile, fixPipDependencyConflict, fixPipIgnoreRequiresPython,
  fixMavenDependencyConflict,
  // corrupted lock file
  fixCorruptedLockfile, fixNpmCiToInstall, fixYarnLockfileCorruption,
  fixPoetryLockfileCorruption, fixGemfileLockCorruption, fixPnpmLockfileCorruption,
  // unsupported version
  fixPipNoCacheDir, fixDeprecatedNpmDependency, fixRequirementsPinning,
  // caching
  fixNpmCacheRestoreKeys, fixPipCache, fixMavenCache, fixGradleCache,
  fixComposerCache, fixGoModCache, fixRustCargoCache,
  // tool setup
  fixHuskyCI, fixMavenWrapperPermission, fixYarnBerrySetup,
  fixNpmRegistryAuth, fixPipPrivateIndex,
} from './fixers/simple/dependencies';

import {
  // Category 1 — Build script failure
  fixNodeHeapMemory, fixWebpackMemoryLimit, fixMissingBuildScript,
  fixGradleWrapperPermission, fixGradleDaemonOOM, fixMavenBuildScript,
  fixTurboPipelineConfig, fixNxBuildSetup, fixPnpmWorkspaceBuild,
  fixCargoWorkspaceBuild, fixNextJsBuildConfig, fixDotnetRestore,
  fixViteProductionBuild, fixMakefileCIMode, fixAndroidGradleBuild,
  fixShellScriptExitCodes,
  // Category 2 — Compilation failure
  fixMissingTsConfig, fixCompilationFailure, fixTypeScriptPathAlias,
  fixESMCJSConflict, fixJavaCompilationError, fixGoCompilationError,
  fixRustCompilationError, fixDotNetCompilationError, fixBabelPresetConfig,
  fixSassMigration, fixKotlinJvmTarget,
  // Category 3 — Missing build artifact
  fixMissingOutputDirectory, fixArtifactOutputPath, fixArtifactIfNoFilesError,
  fixGradleArtifactPath, fixMavenArtifactPath, fixRustBinaryArtifact,
  fixDotNetPublishArtifact, fixGoArtifactPath, fixNextExportArtifact,
  fixDockerSaveArtifact,
  // Category 4 — Invalid build target
  fixInvalidBuildTarget, fixGradleTaskNotFound, fixMavenGoalNotFound,
  fixNpmWorkspaceScript, fixTurboMissingTask, fixBazelBuildTarget,
  // Category 5 — Unsupported runtime version
  fixNodeExperimentalFlags, fixPython2to3, fixJavaReleaseFlag,
  fixRustToolchainFile, fixDotNetTargetFramework, fixGoModDirective,
  fixSwiftToolsVersion,
  // Extended Category 1 — More build script patterns
  fixPrismaGenerate, fixGoGenerateStep, fixLernaBootstrap,
  fixCMakeBuildSetup, fixMakeParallelJobs, fixProtobufGenerate,
  fixDockerComposeBuildService,
  // Extended Category 2 — More compilation patterns
  fixGraphQLCodegen, fixTailwindContentPaths, fixAngularBuildBudget,
  fixSvelteKitAdapter, fixPostCSSConfig, fixNuxtNitroPreset,
  // Extended Category 3 — More artifact patterns
  fixLambdaZipPackage, fixNuGetPackageOutput, fixHelmChartPackage,
  fixElectronArtifactPath, fixPythonWheelBuild,
  // Extended Category 4 — More build target patterns
  fixRakeTask, fixMixTask, fixSbtBuildTask,
  // Extended Category 5 — More runtime version patterns
  fixOpenSSLLegacyProvider, fixRubyKeywordArgs, fixPHPVersionCompat,
  fixRubyNativeExtensions, fixFlutterSDKConstraint,
  // Cross-category
  fixPythonPath, fixNpmCacheNolockfile, fixCodecovNonBlocking,
  fixESBuildPathResolution,
} from './fixers/simple/build';

// ── Intermediate ─────────────────────────────────────────────────────────────
import {
  // Merge conflicts
  fixMergeConflictMarkers, fixMergeUnrelatedHistories, fixGitRebasePullStrategy,
  fixBinaryMergeDriver, fixStashBeforePull, fixCherryPickAbort,
  fixGitMergeStrategyFlag, fixDivergentBranchConfig, fixRebaseBeforeMerge,
  // Detached HEAD
  fixGitLabDetachedHead, fixGitHubActionsDetachedHead, fixDetachedHeadCreateBranch,
  fixCircleCIDetachedHead, fixVersionBumpDetachedHead, fixSHACheckoutToBranch,
  // Invalid branch reference
  fixShallowClone, fixInvalidBranchReference, fixDefaultBranchRename,
  fixMissingUpstreamBranch, fixStaleRemoteTracking, fixBranchNameSanitize,
  fixGitLabDefaultBranch,
  // Failed git push
  fixGitUserConfig, fixGitHubActionsToken, fixNonFastForwardPush,
  fixSSHAgentForPush, fixGitPushFollowTags, fixGitPushAtomic,
  fixGitHubPagesDeploy, fixLargeFilePush, fixGitMirrorPush,
  // Rejected commits
  fixRejectedCommit, fixCommitMessageLint, fixSignedCommitSetup,
  fixDisableSigningInCI, fixProtectedBranchPAT, fixRecursivePipelineTrigger,
  fixPreReceiveSecretHook,
  // Repository access denied
  fixGitRemoteWithToken, fixSSHKnownHosts, fixGitLabDeployKey,
  fixGitHubAppTokenGen, fixPrivateSubmoduleSSH, fixGitHubEnterpriseBaseURL,
  fixAzureDevOpsGitAuth, fixPackageRegistryAuth, fixSelfHostedRunnerGitAuth,
  // Submodule errors
  fixSubmoduleCheckout, fixSubmoduleDeinit, fixSubmoduleRelativeURL,
  fixGitLFSCheckout, fixSubmoduleShallowClone, fixSubmoduleBranchTracking,
  fixSubmoduleUpdateInit, fixNestedSubmoduleRecursive, fixGitmodulesPath,
  fixGitLabSubmoduleStrategy,
  // Cross-cutting / deprecated
  fixDeprecatedSetOutput, fixHuskyPreCommitCI, fixGitConfigSafeDirectory,
  fixGitLabTokenPushAuth, fixGitTagSigning, fixGitCredentialHelper,
  fixMissingGitTags, fixShallowCloneFetchDepth as fixGitShallowCloneFetchDepth, fixSparseCheckout,
  fixAnnotatedTagForRelease, fixFetchAllBranches, fixGitLabCrossProjectToken,
  fixGitGCDiskSpace, fixGitCleanWorkingTree, fixGitLineEndings,
} from './fixers/intermediate/git';

import {
  // Existing
  fixMissingJobNeeds, fixArtifactNameMismatch, fixCacheKeyOverSpecific,
  fixParallelJobTimeouts, fixGitLabStageOrder, fixSecurityJobNonBlocking,
  fixMissingConcurrencyGroup, fixMissingReportsDir, fixDeprecatedSetEnv,
  fixGitLabOptionalStages, fixCircularDependency, fixMissingRunner,
  fixFailedPipelineStageRetry, fixFailFastMatrix, fixArtifactRetentionDays,
  fixMissingJobOutputs, fixGitLabMissingCache,
  // Section A — Failed pipeline stage
  fixShellStrictMode, fixPipelineStageFailureDiagnostic, fixFlakyStageContinueOnError,
  fixGitLabIncrementalPipeline, fixWorkflowRunWait, fixPipelineFailureNotification,
  fixMatrixIncludeExclude,
  // Section B — Incorrect stage order
  fixGitLabStageOrdering, fixGitLabDAGPipeline, fixDanglingNeedsReference,
  fixJobOrderingWithNeeds,
  // Section C — Circular dependency
  fixSelfReferentialNeeds, fixTwoJobCircularChain,
  // Section D — Invalid workflow trigger
  fixPushBranchFilter, fixWorkflowDispatchInputs, fixPullRequestTargetSecurity,
  fixCronScheduleExpression, fixWorkflowCallContract, fixPushTagsPattern,
  fixPathFilterTrigger,
  // Section E — Missing / offline runner
  fixRunnerGroupFallback, fixLargerRunnerSpec, fixJobContainerImage,
  fixOfflineRunnerContinue,
  // Section F — Job timeout
  fixJobTimeout, fixStepLevelTimeout, fixGitLabJobTimeout, fixHangingProcessWatchdog,
  // Section G — Artifact upload failure
  fixArtifactUploadGlob, fixArtifactIfNoFilesFound, fixMultipleArtifactUploads,
  fixGitLabArtifactConfig, fixArtifactCompression, fixS3ArtifactFallback,
  // Section H — Cache restore failure
  fixCacheRestoreKeys, fixCachePathMismatch, fixSetupActionBuiltinCache,
  fixGitLabCachePolicy, fixCacheKeyHashFiles, fixCacheBust,
  // Section I — Parallel job synchronization
  fixBarrierGateJob, fixDownloadAfterUpload, fixParallelJobOutputPaths,
  fixMatrixArtifactFanIn, fixConcurrencyForPR, fixMatrixFanInSummary,
  fixWorkflowLevelEnvSharing,
  // Semantic bug fixers (static analysis)
  fixNeedsContextKeyMismatch, fixWrongResultValueInIf, fixMatrixNodeVersionKey,
} from './fixers/intermediate/pipeline';

import {
  // Existing
  fixActionsVersionUpgrade, fixMissingPermissions, fixOidcPermission,
  fixJobTimeout as fixConfigJobTimeout, fixMissingEslintConfig, fixMissingJestConfig,
  fixMissingDispatchInputs, fixGitLabIncludePath,
  fixIncorrectConfigHierarchy, fixUnsupportedConfigParameter,
  fixMissingPrettierConfig, fixESLintFlatConfig, fixMissingEditorConfig,
  fixPlaywrightBrowserInstall, fixCypressCIDependencies,
  // Section A — Invalid .gitlab-ci.yml
  fixGitLabYamlAnchors, fixGitLabJobMissingImage, fixGitLabExtendsMissing,
  fixGitLabRulesNeverMatch, fixGitLabWorkflowRules, fixGitLabTriggerConfig,
  fixGitLabParallelMatrix, fixGitLabServicesConfig, fixGitLabEnvironmentConfig,
  fixGitLabResourceGroup,
  // Section B — Invalid GitHub Actions syntax
  fixInvalidJobId, fixWorkflowExpressionSyntax, fixWorkflowIfCondition,
  fixMissingStepsKey, fixReusableWorkflowPin, fixMissingWorkflowName,
  fixActionInputTypeMismatch,
  // Section C — Missing config file
  fixMissingTsConfig as fixConfigMissingTsConfig, fixMissingViteConfig, fixMissingVitestConfig,
  fixMissingNvmrc, fixMissingPyprojectToml, fixMissingDockerignore,
  fixMissingGitignore, fixMissingPostcssConfig, fixMissingBabelConfig,
  // Section D — Incorrect config hierarchy
  fixTsConfigExtendsChain, fixGitLabBeforeScriptLevel,
  fixPackageJsonWorkspacesLevel, fixStepUsesAndRunConflict,
  // Section E — Unsupported config parameter
  fixDeprecatedTsConfigOptions, fixDockerComposeVersionField,
  fixIfAlwaysSyntax, fixGitLabCECompatibility, fixNpmEnginesRange,
  // Section F — Duplicate config key
  fixDuplicateJobId, fixDuplicateGitLabStage, fixDuplicateEnvKey,
  fixDuplicateDockerPort, fixDuplicatePermissions, fixDuplicatePackageScript,
  // Section G — Broken environment mapping
  fixEnvContextScope, fixGitLabVariableScope, fixSecretToEnvMapping,
  fixInputToEnvMapping, fixJobOutputDeclaration, fixTerraformVarEnv,
  fixDotenvLoadOrder, fixDockerComposeEnvFile, fixK8sSecretEnvMapping,
  fixMissingSecretsContext, fixMissingAwsRegionMapping,
  // Semantic bug fixers (static analysis)
  fixQuotedExpressionLiteral, fixContentsNonePermission, fixMissingStepIdForOutput,
  fixSonarCloudConfig, fixRetentionDaysType,
  fixDenyLicensesType, fixExternalServiceJobNonBlocking,
} from './fixers/intermediate/config';

import {
  fixNodeHeapOOM, fixUnhandledRejection, fixSegmentationFault,
  fixPythonRecursionLimit, fixOpenFilesLimit, fixLinuxMemoryFragmentation,
  fixStackOverflow, fixNullReferenceException, fixTypeMismatch,
  // Section A — Null reference
  fixStrictNullChecks, fixPythonNoneCheck, fixGoNilPointerDeref,
  fixRustUnwrapToExpect, fixJavaNPEGuard, fixCSharpNullConditional,
  fixArrayBoundsCheck, fixNullDerefOptionalChain, fixNullCoalescingEnvDefault,
  // Section B — Type mismatch
  fixImplicitAnyError, fixPythonMypyCheck, fixGoTypeAssertion,
  fixRustTypeCast, fixPHPStrictTypes, fixRubySorbetTypeCheck,
  fixPyrightTypeCheck, fixTypeCheckBeforeBuild,
  // Section C — Infinite loop
  fixCIInfiniteLoopKill, fixLoopIterationGuard, fixPythonTestHangTimeout,
  fixJestTestHangTimeout, fixMochaForceExit, fixPlaywrightPageTimeout,
  fixNodeEventListenerLeak, fixAsyncRetryMaxCap,
  // Section D — Stack overflow
  fixJVMStackSize, fixPythonConfTestRecursion, fixRubyStackSize,
  fixDotNetStackSize, fixRustStackSize, fixGoStackTrace,
  // Section E — Memory allocation
  fixJVMHeapConfig, fixGradleJVMArgs, fixGoMemoryTuning,
  fixPythonMemoryLimit, fixDockerMemoryLimit, fixUlimitVirtualMemory,
  fixK8sPodMemoryLimit, fixSwapSpaceCI,
  // Section F — Segfault
  fixAddressSanitizerBuild, fixPythonFaultHandler, fixRustMiriCheck,
  fixValgrindMemCheck, fixCoreDumpUpload, fixNodeNativeAddonCrash,
  // Section G — Unhandled exception
  fixExpressErrorMiddleware, fixPromiseAllSettled, fixAsyncTryCatch,
  fixPythonExceptionLogging, fixJavaUncaughtExceptionHandler,
  fixDotNetUnhandledException, fixSentryRuntimeCapture,
  fixBrowserGlobalErrorHandler, fixRuntimeExceptionDiagnostics,
} from './fixers/intermediate/runtime';

import {
  // Original
  fixJestCIFlag, fixCoverageThreshold, fixMissingTestScript,
  fixTestTimeout, fixMissingVitestConfig as fixTestingMissingVitestConfig, fixStaleMocks,
  fixNoTestFiles, fixCreateMinimalTest,
  fixUnitTestFailure, fixIntegrationTestFailure, fixTestEnvironmentMisconfig,
  // Section A — Unit test (extended)
  fixJestRunInBand, fixJestForceExit, fixFlakyTestRetry, fixVitestRetry,
  fixPytestRerunFails, fixGoTestTimeout, fixRustTestSerial,
  fixDotNetTestLogger, fixJestWorkerCount,
  // Section B — Integration test (extended)
  fixDockerComposeTestUp, fixTestContainersPull, fixDatabaseMigrationBeforeTest,
  fixKafkaServiceIntegration, fixMinioServiceIntegration, fixGRPCServiceHealth,
  fixIntegrationTestRetry, fixTestDatabaseIsolation, fixWaitForServiceReady,
  // Section C — Snapshot mismatch
  fixJestUpdateSnapshot, fixSnapshotSerializer, fixSnapshotDiffArtifact,
  fixPlaywrightVisualBaseline, fixInlineSnapshotFormat, fixObsoleteSnapshots,
  fixVitestUpdateSnapshot, fixStorybookSnapshotTest,
  // Section D — Mock dependency failure
  fixEsmMockSupport, fixMockModuleReset, fixMockTimers, fixModuleNameMapper,
  fixPythonMockPatch, fixNockHttpMocking, fixVitestMockHoisting,
  fixMockEnvVarSetup, fixMSWSetup,
  // Section E — Test environment (extended)
  fixJestSetupFiles, fixVitestSetupFiles, fixJestTransformIgnore,
  fixJestModuleExtensions, fixPytestConftestSetup, fixCypressConfig,
  fixVitestAliasConfig, fixJestCIOverrides,
  // Section F — Coverage (extended)
  fixCoverageJSONReporter, fixVitestCoverageProvider, fixCodecovUploadStep,
  fixCoverageArtifactUpload, fixCoverageCollectAllFiles, fixCoverageExcludeGenerated,
  fixPerFileCoverageThreshold, fixPytestCoverageConfig, fixGitLabCoverageRegex,
} from './fixers/intermediate/testing';

// ── Advanced ─────────────────────────────────────────────────────────────────
import {
  fixDockerJobOnPushOnly, fixDockerAndDeployJobsNonBlocking,
  fixGitLabDockerJobGuard, fixSSHKnownHosts as fixAdvancedSSHKnownHosts, fixGitRemoteWithToken as fixAdvancedGitRemoteWithToken,
  fixGitLabCrossProjectToken as fixAdvancedGitLabCrossProjectToken, fixOidcPermission as fixAdvancedOidc,
  fixExpiredToken, fixNpmPrivateRegistry,
  // Section A — Invalid Access Token
  fixMissingBearerPrefix, fixGitHubTokenScopes, fixSAMLSSOTokenAuth,
  fixFineGrainedPATAccess, fixWrongSecretReference,
  fixAzureServicePrincipalAuth, fixGCPWorkloadIdentityAuth,
  fixAWSSTSAssumeRole, fixGitHubAppInstallationToken, fixAPIKeyQueryToHeader,
  // Section B — Expired Token
  fixTokenValidationPreflight, fixNPMTokenExpiry, fixDockerHubTokenExpiry,
  fixAWSCredentialOIDCUpgrade, fixGCPSAKeyRefresh,
  fixHerokuAPIKeyRotation, fixAtlassianAPITokenExpiry, fixTerraformCloudTokenRenewal,
  // Section C — Permission Denied
  fixContentsWritePermission, fixPackagesWritePermission, fixPackagesReadPermission,
  fixPullRequestsWritePermission, fixIssuesWritePermission, fixChecksWritePermission,
  fixPagesDeployPermission, fixDeploymentsWritePermission,
  fixSecurityEventsWritePermission, fixActionsReadPermission,
  fixWorkflowPermissionsBlock, fixGitLabProtectedBranchPushGuard,
  // Section D — OAuth Authentication Failure
  fixOAuthRedirectURIMismatch, fixOAuthMissingScopes, fixOAuthCSRFState,
  fixGitHubOAuthAppConfig, fixGoogleOAuthServiceAccount, fixOAuthCallbackURLEnvVar,
  fixOAuthPKCEVerifier, fixOAuthTokenStorage,
  // Section E — SSH Key Mismatch
  fixSSHKeyFormatEd25519, fixSSHAgentSocketForwarding, fixSSHDeployKeyWriteAccess,
  fixSSHKeyPassphraseCI, fixSSHHostKeyAlgorithmMismatch, fixSSHMultipleHostsKeyscan,
  fixSSHKeyFilePermissions600, fixGitLabDeployKeyWriteAccess, fixSSHJumpHostConfig,
  // Section F — Secret Access Denied
  fixEnvironmentSecretDeclaration, fixForkPRSecretsUnavailable,
  fixOrganizationSecretRepositoryAccess, fixBranchRestrictedSecretAccess,
  fixRequiredSecretPresenceCheck, fixGitLabProtectedVariableAccess,
  fixPullRequestTargetForForkSecrets, fixHashiCorpVaultTokenRenewal,
  // Section G — Insufficient Role Permissions
  fixAWSIAMPermissionDiagnostic, fixGCPIAMRoleBinding, fixAzureRBACRoleAssignment,
  fixKubernetesClusterRoleBinding, fixTerraformStateBucketPermissions,
  fixGitHubOIDCTrustPolicy, fixECRRepositoryCrossAccountPolicy,
  fixCloudRunServiceAccountInvoker,
  // Section H — Cross-Project Access Failure
  fixCrossRepoCheckoutWithPAT, fixGitLabGroupAccessToken, fixPrivateSubmoduleTokenAuth,
  fixGHCRCrossOrgPackageRead, fixECRCrossAccountAccess,
  fixGitLabCrossGroupCITrigger, fixGoogleArtifactRegistryAuth, fixAzureContainerRegistryAuth,
} from './fixers/advanced/auth';

import {
  fixCreateMinimalDockerfile, fixEnableDockerBuildKit,
  fixDockerBaseImagePin, fixDockerHealthcheck, fixDockerPortExpose,
  fixDockerVolumePermissions, fixDockerHubRateLimit, fixMissingDockerignore as fixDockerMissingDockerignore,
  fixMissingDockerLayer, fixPortBindingConflict, fixDockerImagePullFailure,
  // Section A — Docker Image Build Failure
  fixDockerBuildContextTooLarge, fixDockerBuildArgMissing, fixDockerMultiStageBuild,
  fixDockerRUNLayerMerge, fixDockerAPTGetUpdate, fixDockerNPMInstallProd,
  fixDockerPipNoCacheDir, fixDockerCopyOrderForCache, fixDockerShellToExecForm,
  fixDockerBuildPlatformArg, fixDockerQEMUSetup, fixDockerLayerCleanup,
  // Section B — Missing Docker Layer
  fixDockerGHACacheMount, fixDockerRegistryLayerCache, fixDockerManifestUnknown,
  fixDockerPullRetryOnBlob, fixDockerBuildKitCacheMount, fixDockerSetupBuildx,
  fixDockerMetadataAction, fixDockerServicePullPolicy,
  // Section C — Invalid Dockerfile Syntax
  fixDockerfileHeredocSyntax, fixDockerfileEnvVsArg, fixDockerfileCmdEntrypointInteraction,
  fixDockerfileJSONArraySyntax, fixDockerfileAddVsCopy, fixDockerfileWorkdirAbsolute,
  fixDockerfileLabelFormat, fixDockerfileNonRootUser, fixDockerignoreSecrets,
  fixDockerfileWildcardCopy,
  // Section D — Container Startup Failure
  fixDockerTiniInit, fixDockerEntrypointEnvCheck, fixDockerWaitForDependencies,
  fixDockerStopSignal, fixDockerTimezone, fixDockerUlimits,
  fixDockerResourceLimits, fixDockerRestartPolicy, fixDockerLoggingConfig,
  fixDockerStartupHealthcheck,
  // Section E — Port Binding Conflict Extended
  fixDockerRandomPortAssignment, fixDockerNetworkSubnetConflict, fixDockerIPv6BindingConflict,
  fixDockerComposePortFormat, fixDockerServiceContainerPorts,
  // Section F — Registry Auth Extended
  fixDockerGHCRLogin, fixDockerECRLogin, fixDockerACRLoginStep, fixDockerGARLoginStep,
  fixDockerHubAccessToken, fixDockerPrivateRegistryCA, fixDockerCredentialHelper,
  // Section G — Image Pull Failure Extended
  fixDockerImageDigestPin, fixDockerRegistryPathFormat, fixDockerTagFallback,
  fixDockerComposePrivateImageAuth, fixDockerAlpineApkMirror, fixDockerTrivyScanStep,
  fixDockerPullPlatformMismatch,
  // Section H — Volume Mount Failure
  fixDockerNamedVolumes, fixDockerVolumeSelinuxLabel, fixDockerBindMountAbsolutePath,
  fixDockerVolumeReadOnly, fixDockerTmpfsMount, fixDockerNFSVolumeOptions,
  fixDockerVolumeDriverConfig, fixDockerComposeInit,
} from './fixers/advanced/docker';

import {
  fixDeployRollbackOnFailure, fixBlueGreenHealthCheck, fixConnectionDraining,
  fixCanaryDeployment, fixSSHDeployNonBlocking, fixK8sRolloutWait,
  fixGitLabDeployEnvironment, fixServiceUnavailable, fixLoadBalancerRouting,
  // Section A — Deployment Rollback Failure
  fixHelmRollbackOnFailure, fixKubectlRollbackAnnotation, fixK8sRollbackHistoryLimit,
  fixHerokuReleaseRollback, fixECSRollbackTaskDef, fixCloudRunRollbackRevision,
  fixTerraformDestroyGuard, fixGitLabDeployRollback, fixDeployRollbackNotification,
  fixAzureSlotRollback, fixFlyioRollback, fixArgoRollbackSyncWave,
  // Section B — Failed Production Deployment
  fixProdDeployGatingJob, fixConcurrentDeployPrevention, fixPreDeploySmoke,
  fixDeployEnvValidation, fixTerraformPlanBeforeApply, fixHelmDryRunFirst,
  fixK8sApplyValidation, fixDeployTimeoutExtension, fixDockerImageHealthProbe,
  fixProdDeployBranchGuard, fixDeployTaggedRelease,
  // Section C — Blue-Green Deployment Conflict
  fixBlueGreenK8sService, fixBlueGreenALBTargetGroup, fixBlueGreenDatabaseMigration,
  fixBlueGreenSmoke, fixBlueGreenRollback, fixBlueGreenSessionDrain,
  fixAzureSlotWarmup, fixBlueGreenConfigSync, fixBlueGreenTTL,
  // Section D — Canary Deployment Mismatch
  fixCanaryIngressAnnotation, fixCanaryK8sReplicaCount, fixCanaryMetricAnalysis,
  fixCanaryRollbackThreshold, fixCanaryCloudRunRevision, fixCanaryECSTaskWeight,
  fixCanaryProgressivePause, fixCanaryFlaggerHPA, fixCanaryHeaderRouting,
  // Section E — Service Unavailable Extended
  fixServiceStartupProbe, fixServicePodDisruptionBudget, fixServiceHPAMinReplicas,
  fixServiceGracefulShutdown, fixServiceTopologySpread, fixServiceCircuitBreaker,
  fixServiceReadinessGate, fixServiceResourceQuota,
  // Section F — Health Check Failure Extended
  fixHealthCheckEndpointPath, fixHealthCheckInterval, fixHealthCheckDependencies,
  fixHealthCheckHTTPS, fixHealthCheckPort, fixLivenessReadinessProbes,
  fixStartupProbeTimeout, fixHealthCheckResponseCode,
  // Section G — Load Balancer Routing Issue Extended
  fixALBTargetGroupHealthCheck, fixNGINXProxyReadTimeout, fixNLBPreserveClientIP,
  fixCORSHeadersLB, fixHTTPSRedirectLB, fixLBStickySessions,
  fixLBDrainingTimeout, fixTraefikRouteConfig,
} from './fixers/advanced/deployment';

import {
  fixAPIRetryOnTimeout, fixRateLimitBackoff, fixWebhookSecret,
  fixAPIVersionHeader, fixSSLCertVerification, fixAPIPagination,
  fixSlackNotificationSecret, fixGHCLIAuth,
  fixInvalidAPIResponse, fixBrokenThirdPartyIntegration,
  fixSchemaValidationFailure, fixGraphQLQueryFailure,
  // Section A — API Timeout
  fixAPIConnectTimeout, fixAxiosTimeout, fixFetchAbortController,
  fixServiceMeshTimeout, fixGRPCDeadline, fixGraphQLRequestTimeout,
  fixAPIGatewayIntegrationTimeout, fixCurlRetryFlags, fixJobAPICallTimeout,
  // Section B — Rate Limiting
  fixGitHubAPIRateLimit, fixRetryAfterHeader, fixNpmPublishRateLimit,
  fixAPIBulkBatching, fixLeakyBucketSleep, fixStripeRateLimit,
  fixGitLabAPIThrottle, fixSendGridRateLimit, fixDockerHubAnonymousPullLimit,
  // Section C — Invalid API Response
  fixAPIResponseJSONParse, fixAPIEmptyResponseGuard, fixRedirectHandling,
  fixAPIStatusCodeRange, fixAPIContentTypeCheck, fixAPIResponseCaching,
  fixAPIEnvelopeUnwrap, fixAPIErrorBodyParsing,
  // Section D — Webhook Delivery Failure
  fixWebhookHMACVerification, fixWebhookReplayProtection, fixWebhookIdempotencyKey,
  fixWebhookTimeoutResponse, fixWebhookPayloadSize, fixWebhookIPAllowlist,
  fixWebhookTLSValidation, fixGitHubWebhookEvents,
  // Section E — Broken Third-Party Integration
  fixSentryDSNEnvVar, fixDatadogAgentConfig, fixSonarCloudQualityGate,
  fixCodecovTokenMissing, fixSnykAuthToken, fixPagerdutyIntegration,
  fixJiraIntegrationConfig, fixNewRelicLicenseKey,
  // Section F — Schema Validation Failure
  fixOpenAPISpectralLint, fixJSONSchemaVersion, fixAJVStrictMode,
  fixProtobufSchemaBreaking, fixOpenAPIRequestValidator, fixSchemaRegistryCompat,
  fixGraphQLSchemaLint, fixZodSchemaValidation,
  // Section G — GraphQL Query Failure
  fixGraphQLIntrospectionQuery, fixGraphQLFragmentDefinition, fixGraphQLNullableFields,
  fixGraphQLPersistQuery, fixGraphQLDeprecatedField, fixGraphQLCORSHeaders,
  fixGraphQLBatchRequest,
  // Section H — REST Endpoint Mismatch
  fixRESTBaseURLEnvVar, fixRESTVersionPrefix, fixRESTMethodMismatch,
  fixRESTTrailingSlash, fixRESTAuthHeader, fixRESTContentTypeHeader,
  fixRESTEndpointEnvMatrix, fixRESTIdempotencyHeader, fixRESTResponseTimeLogging,
} from './fixers/advanced/api';

import {
  fixWaitForDatabase, fixMigrationLockTimeout,
  fixQueryExecutionFailure, fixReplicationLag,
  // Section A — Migration Failure (shared)
  fixFlywayCIConfig, fixLiquibaseChangelog, fixPrismaMigrateDeploy,
  fixRailsMigrationIdempotent, fixKnexMigrationSource, fixSequelizeMigrationState,
  fixMigrationBaselineExisting,
  // Section B — Connection Timeout (shared)
  fixPGConnectionPool, fixMySQLConnectionPool, fixMongoConnectionTimeout,
  fixRedisConnectionRetry, fixDBConnectionSSL, fixDBConnectionKeepalive,
  // Section C — Deadlock Detected (shared)
  fixDeadlockRetryLogic, fixDeadlockLockTimeout, fixDeadlockIsolationLevel,
  fixDeadlockRowLevelLocking, fixDeadlockCISerialRun, fixDeadlockIndexForUpdate,
  // Section D — Schema Mismatch (shared)
  fixTypeORMSchemaDrop, fixRailsSchemaLoad, fixFlywaySchemaDiff,
  fixLiquibaseValidate, fixSchemaBackwardCompat,
  // Section E — Query Execution Failure (shared)
  fixSlowQueryTimeout, fixNPlusOneQueryDetect, fixDBQueryLogging,
  fixQueryMemoryLimit, fixQueryResultPagination, fixQueryTransactionWrapper,
  // Section F — Missing Index (shared)
  fixCompositeIndexCreation, fixPartialIndexCreation, fixGINIndexForJSONB,
  fixForeignKeyIndex, fixUniqueIndexConstraint, fixQueryPlannerHint,
  // Section G — Transaction Rollback (shared)
  fixTransactionSavepoint, fixTransactionIsolationLevel, fixTransactionTimeout,
  fixTransactionDeadlockRetry, fixTransactionConnectionReturn,
  fixNestedTransactionPrisma, fixTransactionRollbackLogging, fixAtomicMigrationTransaction,
  // Section H — Replication Lag (shared)
  fixReadWriteSplit, fixSynchronousCommit, fixLogicalReplicationSetup, fixReplicationFailoverConfig,
  // Semantic bug fixers (static analysis)
  fixPostgresServiceConfig,
} from './fixers/advanced/database';

import {
  fixPrismaShadowDb, fixMissingDatabaseIndex, fixMissingDBService,
  fixMissingDatabaseURL, fixMissingMySQLService, fixMissingRedisService,
  // Section A — Migration Failure (GitHub Actions)
  fixAlembicRevisionCheck, fixGooseMigrationVersion, fixMigrationRollbackStep,
  // Section B — Connection Timeout (GitHub Actions)
  fixDBConnectionEnvValidation, fixDBConnectionProxyTimeout, fixDBNetworkPolicyCIJob,
  // Section C — Deadlock Detected (GitHub Actions)
  fixDeadlockMonitoring, fixDeadlockConcurrencyGroup,
  // Section D — Schema Mismatch (GitHub Actions)
  fixSchemaDriftDetection, fixPrismaSchemaSync, fixDjangoMakeMigrationsCheck, fixSchemaVersionTable,
  // Section E — Query Execution Failure (GitHub Actions)
  fixQueryAnalyzeExplain, fixQueryStatStatements,
  // Section F — Missing Index (GitHub Actions)
  fixIndexStatisticsUpdate, fixIndexBloatReindex,
  // Section H — Replication Lag (GitHub Actions)
  fixReplicationSlotMonitor, fixReplicaHealthCheck, fixReplicationMonitoringStep, fixCDCEventStreamLag,
} from './fixers/advanced/database_github';

import {
  fixGitLabDBService, fixGitLabMySQLService, fixGitLabRedisService,
  fixGitLabDatabaseURL, fixGitLabPrismaShadowDb, fixGitLabMissingDatabaseIndex,
  // Section A — Migration Failure (GitLab CI)
  fixGitLabAlembicRevisionCheck, fixGitLabGooseMigrationVersion, fixGitLabMigrationRollback,
  // Section B — Connection Timeout (GitLab CI)
  fixGitLabDBConnectionValidation, fixGitLabProxyConnectionWait, fixGitLabNetworkPolicy,
  // Section C — Deadlock Detected (GitLab CI)
  fixGitLabDeadlockMonitoring, fixGitLabResourceGroup as fixGitLabDbResourceGroup,
  // Section D — Schema Mismatch (GitLab CI)
  fixGitLabSchemaDriftDetection, fixGitLabPrismaSchemaSync, fixGitLabDjangoMigrationsCheck, fixGitLabSchemaVersionTable,
  // Section E — Query Execution Failure (GitLab CI)
  fixGitLabQueryExplainOnFail, fixGitLabQueryStatStatements,
  // Section F — Missing Index (GitLab CI)
  fixGitLabIndexStatistics, fixGitLabIndexBloatCheck,
  // Section H — Replication Lag (GitLab CI)
  fixGitLabReplicationSlotMonitor, fixGitLabReplicaHealthCheck, fixGitLabReplicationLagWait, fixGitLabCDCLagCheck,
} from './fixers/advanced/database_gitlab';

// ── Code — surgical edits to application source at log-referenced lines ────
import {
  fixCompilerSuggestions,
  fixUnusedImports, fixPythonUnusedImports, fixPreferConst, fixDebuggerStatements,
  fixWhitespaceLint, fixFocusedTests, fixUnusedTsExpectError, fixNullDerefAtStackFrame,
  fixMissingPythonPackage, fixEslintRuleViolations, fixPythonLintViolations, fixMissingExport,
  fixPythonModulePath, fixPyYamlLoad,
  isAppSourceFile, logReferencedSourcePaths, withStableLineNumbers, hasLinePlaceholders, stripLinePlaceholders,
} from './fixers/code/source';
import {
  fixMissingNpmPackage, fixUnavailablePinnedVersion, fixIncompatiblePythonPins, fixVulnerableDependencies,
  fixJestEnvironmentMissing, fixNodeEngineMismatch, fixMissingRequirementsFile, fixVirtualenvNotCreated, fixArtifactPathMismatch,
} from './fixers/code/manifests';
import {
  fixComposeHostPortCollision, fixK8sSelectorLabelMismatch, fixDockerfilePath, fixDockerfileUnknownInstruction, fixMissingBindSource,
  fixZeroRevisionHistory,
} from './fixers/advanced/infraStatic';

import { isYamlPath, yamlParseError } from './yamlCheck';

/** Rule edits discarded by the last applyRuleBasedFixes() call because they
 *  would have made a valid YAML file unparseable (diagnostics / tests). */
export const rejectedRules: Array<{ path: string; explanation: string; error: string; before?: string; after?: string }> = [];

// ── Repair-only policy ───────────────────────────────────────────────────────
//
// Rules that read the CI logs act only on the failure they describe. Rules that
// read only file content would fire on every repo, so during healing they run
// only when the change is a repair:
//   • always-run rules must be in STATIC_REPAIRS — they fix a definition that is
//     invalid on its own (the runner, parser or API rejects it), so no log is needed;
//   • rules inside a diagnosed-category block run unless they are in HARDENING —
//     optional improvements (caching, probes, notifications, env niceties, style)
//     that do not fix the failure.
// { hardening: true } restores every rule, for audits that want the improvements too.

type FileRule = (files: Array<{ path: string; content: string }>) => RuleFix[];

const STATIC_REPAIRS = new Set<FileRule>([
  // YAML / workflow definitions GitHub or GitLab refuse to run
  fixYamlTabIndentation, fixDuplicateYamlKey, fixDuplicateEnvKey, fixDuplicatePermissions, fixDuplicateGitLabStage,
  fixIncorrectConfigHierarchy, fixIncorrectExpressionDelimiter, fixStepUsesAndRun, fixStepUsesAndRunConflict,
  fixMissingWorkflowTrigger, fixWorkflowTriggerTypo, fixMissingWorkflowCallTrigger, fixInvalidCronExpression,
  fixRunnerLabelTypo, fixRetentionDaysType, fixDenyLicensesType, fixDeprecatedSetEnv, fixPushBranchFilter,
  fixGitLabStageOrder, fixMergeConflictMarkers,
  // expressions that silently evaluate to empty (outputs, needs, matrix, env/if scoping)
  fixQuotedExpressionLiteral, fixMissingJobOutputs, fixMissingJobOutputsDeclaration, fixJobOutputDeclaration,
  fixMissingStepIdForOutput, fixNeedsContextKeyMismatch, fixStepOutputScopeError, fixWrongResultValueInIf,
  fixEnvContextScope, fixMatrixNodeVersionKey, fixMissingDispatchInputs,
  // steps guaranteed to fail on the runner
  fixNpmCacheNolockfile, fixNpmCiToInstall, fixAptGetSudo, fixBashSyntaxInPosixSh, fixLinuxCommandsOnWindows,
  fixMissingCheckoutStep, fixAddInstallStep, fixMissingYarnInstallStep, fixMissingReportsDir, fixDownloadAfterUpload,
  fixPostgresServiceConfig, fixSonarCloudConfig,
  // infrastructure definitions the runtime rejects
  fixDuplicateDockerPort, fixComposeHostPortCollision, fixK8sSelectorLabelMismatch,
]);

const HARDENING = new Set<FileRule>([
  // caching / performance
  fixNpmCacheRestoreKeys, fixSetupActionBuiltinCache, fixRustCargoCache, fixGitLabMissingCache, fixGitLabCachePolicy,
  fixPipNoCacheDir, fixMakeParallelJobs, fixViteProductionBuild, fixGitLabIncrementalPipeline, fixGitLabDAGPipeline,
  fixDockerBuildKitCacheMount, fixDockerGHACacheMount, fixDockerRegistryLayerCache, fixDockerServicePullPolicy,
  fixDockerCopyOrderForCache, fixDockerRUNLayerMerge, fixDockerAPTGetUpdate, fixDockerLayerCleanup, fixDockerPipNoCacheDir,
  fixDockerNPMInstallProd, fixMavenBuildScript,
  // container / cluster hardening
  fixDockerBaseImagePin, fixDockerImageDigestPin, fixDockerCredentialHelper, fixDockerEntrypointEnvCheck,
  fixDockerStartupHealthcheck, fixDockerStopSignal, fixDockerTimezone, fixDockerTiniInit, fixDockerComposeInit,
  fixDockerLoggingConfig, fixDockerNamedVolumes, fixDockerVolumeReadOnly, fixDockerShellToExecForm,
  fixDockerfileAddVsCopy, fixDockerfileCmdEntrypointInteraction, fixDockerfileLabelFormat, fixDockerfileNonRootUser,
  fixDockerfileWorkdirAbsolute, fixDockerignoreSecrets, fixDockerMissingDockerignore, fixMissingDockerignore,
  fixDockerComposePortFormat, fixDockerMetadataAction, fixDockerComposeBuildService, fixDockerImageHealthProbe,
  fixServiceHPAMinReplicas, fixServicePodDisruptionBudget, fixServiceReadinessGate, fixServiceTopologySpread,
  fixK8sRollbackHistoryLimit, fixK8sRolloutWait, fixKubectlRollbackAnnotation, fixArgoRollbackSyncWave,
  fixDeployRollbackOnFailure, fixNextJsBuildConfig, fixNuxtNitroPreset,
  // deploy policy / workflow structure preferences
  fixConcurrentDeployPrevention, fixProdDeployBranchGuard, fixProdDeployGatingJob, fixDeployTaggedRelease,
  fixSSHDeployNonBlocking, fixBarrierGateJob, fixMatrixFanInSummary, fixMatrixArtifactFanIn, fixFailFastMatrix,
  fixWorkflowLevelEnvSharing, fixConcurrencyForPR, fixMissingConcurrencyGroup, fixPathFilterTrigger, fixPushTagsPattern,
  fixWorkflowCallContract, fixWorkflowDispatchInputs, fixMissingWorkflowName, fixReusableWorkflowPin,
  fixIfAlwaysSyntax, fixWorkflowIfCondition, fixPullRequestTargetSecurity, fixPipelineFailureNotification,
  fixArtifactIfNoFilesFound, fixGitLabArtifactConfig, fixGitLabEnvironmentConfig, fixGitLabResourceGroup,
  fixGitLabRulesNeverMatch, fixGitLabStageOrdering, fixGitLabVariableScope, fixGitLabWorkflowRules, fixRebaseBeforeMerge,
  fixLambdaZipPackage, fixHelmChartPackage, fixNuGetPackageOutput, fixPythonWheelBuild, fixRakeTask,
  fixTailwindContentPaths, fixSvelteKitAdapter,
  // env-var niceties and placeholder files
  fixCargoEnvVars, fixGoEnvVars, fixJavaEnvVars, fixPythonEnvVars, fixTerraformEnvVars, fixRESTBaseURLEnvVar,
  fixRESTEndpointEnvMatrix, fixCreateDotEnvExample, fixInputToEnvMapping, fixMissingSecretsContext,
  fixUndeclaredEnvVarReference, fixEventInputScope, fixRustToolchainFile,
  // replaced by log-driven, working-directory-aware rules (fixMissingRequirementsFile, fixNodeEngineMismatch,
  // fixDockerfilePath) — writing a requirements.txt or Dockerfile from scratch is a guess, not a repair
  fixCreateRequirementsTxt, fixCreateMinimalDockerfile,
]);

// ── Masking guard ────────────────────────────────────────────────────────────
// A heal must fix the failure, not switch the check off. Edits that newly make a
// failing step/job non-blocking, swallow its exit code, or lower a quality bar
// turn CI green without healing anything — they are rejected while healing.

const MASKING_LINE: Array<[RegExp, string]> = [
  [/^\s*continue-on-error:\s*true\b/, 'makes the step/job non-blocking (continue-on-error)'],
  [/^\s*allow_failure:\s*true\b/, 'makes the GitLab job non-blocking (allow_failure)'],
  [/\|\|\s*(?:true|:|exit\s+0)\s*(?:#.*)?$/, "swallows the command's exit code (|| true)"],
  [/fail_ci_if_error:\s*false/, 'ignores upload failures (fail_ci_if_error: false)'],
  [/--passWithNoTests\b/, 'passes a test run that ran no tests'],
];

/** Why `after` masks a failure that `before` would report — null when it does not. */
export function maskingReason(before: string | undefined, after: string): string | null {
  const had = new Set((before ?? '').split('\n').map(l => l.trim()));
  for (const line of after.split('\n')) {
    if (had.has(line.trim())) continue;
    for (const [re, why] of MASKING_LINE) if (re.test(line)) return why;
  }
  // lowered coverage thresholds (jest/vitest/nyc/pytest-cov)
  const thresholds = (text: string) => new Map([...text.matchAll(/\b(branches|functions|lines|statements|fail[_-]under)["']?\s*[:=]\s*(\d+(?:\.\d+)?)/gi)].map(m => [m[1].toLowerCase(), +m[2]]));
  if (before) {
    const was = thresholds(before);
    for (const [k, v] of thresholds(after)) if (was.has(k) && v < was.get(k)!) return `lowers the ${k} coverage threshold (${was.get(k)} → ${v})`;
  }
  return null;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export interface RuleOptions {
  /** Also run optional hardening rules that do not fix the failure (off while healing). */
  hardening?: boolean;
  /** Complete job logs, for the rules that parse exact tool output — whole reports (npm audit /
   *  pip-audit tables, pip build output) and every compiler/linter row (the error-focused text
   *  is size-capped and can drop rows). Every other rule reads `logs`: full logs also carry
   *  setup chatter (checkout, deprecation notices) that would trigger keyword-matched rules. */
  reportLogs?: string;
}

/** CI log text as tools printed it: runner timestamps, "##[error]" annotations and
 *  ANSI colours removed, indentation kept — every rule parses this form. */
export function normalizeCiLog(logs: string): string {
  return logs.split('\n').map(l => l
    .replace(/\u001b\[[0-9;]*m/g, '')                         // eslint-disable-line no-control-regex
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '')
    .replace(/^##\[(?:error|warning|notice|debug|group|endgroup)\]/, '')
    .replace(/\r$/, ''),
  ).join('\n');
}

export function applyRuleBasedFixes(
  category: ErrorCategory | ErrorCategory[],
  rawLogs: string,
  files: Array<{ path: string; content: string }>,
  options: RuleOptions = {},
): RuleFix[] {
  const logs = normalizeCiLog(rawLogs);
  const reportLogs = options.reportLogs ? normalizeCiLog(options.reportLogs) : logs;
  // Accept a single category or the full ranked list from categorizeAllErrors.
  // hasCategory fires the fix block when ANY detected category matches —
  // this means simultaneous failures (lint + missing dep + docker auth) all
  // get their dedicated fixers applied in one pass.
  const cats: ErrorCategory[] = Array.isArray(category) ? category : [category];
  const hasCategory = (c: ErrorCategory) => cats.includes(c);

  // Thread files sequentially — each rule sees the previous rule's output
  // so multiple rules on the same file compose correctly (never overwrite each other).
  // Guard at population time: skip any file with a non-string or missing path/content
  // so downstream isGitHubWorkflow(path) calls never receive undefined.
  const working = new Map<string, string>(
    files
      .filter(f => f.path && typeof f.path === 'string' && typeof f.content === 'string')
      .map(f => [f.path, f.content]),
  );
  const explanations = new Map<string, string[]>();
  rejectedRules.length = 0;
  const yamlValid = new Map<string, boolean>();
  const confidences  = new Map<string, number[]>();

  function applyBatch(batch: RuleFix[]) {
    for (const fix of batch) {
      if (typeof fix.content !== 'string') continue;
      if (!fix.path || typeof fix.path !== 'string') continue;
      // Idempotency: several rules are invoked from more than one section
      // (always-run + category block). The same rule must not apply twice to a
      // file — non-idempotent rules would insert their step/block again.
      if (explanations.get(fix.path)?.includes(fix.explanation)) continue;
      // Heal, don't hide: an edit that only silences the failing check is not a fix.
      if (!options.hardening) {
        const masked = maskingReason(working.get(fix.path), fix.content);
        if (masked) { rejectedRules.push({ path: fix.path, explanation: fix.explanation, error: `masks the failure: ${masked}` }); continue; }
      }
      // Composition safety: one rule that breaks YAML must not poison every
      // other rule's fix to the same file — drop just that rule's edit.
      if (isYamlPath(fix.path)) {
        const err = yamlParseError(fix.path, fix.content);
        const prev = working.get(fix.path);
        // Validity of the current working copy is cached — accepted edits are
        // valid by construction, so each file is parsed at most once per edit.
        let prevValid = yamlValid.get(fix.path);
        if (prevValid === undefined) {
          prevValid = prev === undefined || yamlParseError(fix.path, prev) === null;
          yamlValid.set(fix.path, prevValid);
        }
        if (!err) yamlValid.set(fix.path, true);
        if (err && prevValid) {
          rejectedRules.push({ path: fix.path, explanation: fix.explanation, error: err, before: prev, after: fix.content });
          continue;
        }
      }
      working.set(fix.path, fix.content);
      if (!explanations.has(fix.path)) { explanations.set(fix.path, []); confidences.set(fix.path, []); }
      explanations.get(fix.path)!.push(fix.explanation);
      confidences.get(fix.path)!.push(fix.confidence);
    }
  }

  // Snapshot current working state — filter both path AND content to guarantee
  // downstream isGitHubWorkflow(path) calls always receive a real string.
  const snap = (): Array<{ path: string; content: string }> =>
    [...working.entries()]
      .filter(([path, content]) => path && typeof path === 'string' && typeof content === 'string')
      .map(([path, content]) => ({ path, content }));

  // File-only rules go through the repair-only policy (see STATIC_REPAIRS / HARDENING).
  const hardening = options.hardening ?? false;
  const staticRule = (fix: FileRule) => { if (hardening || STATIC_REPAIRS.has(fix)) applyBatch(fix(snap())); };
  const categoryRule = (fix: FileRule) => { if (hardening || !HARDENING.has(fix)) applyBatch(fix(snap())); };

  // Application source is edited only by the surgical fixers in fixers/code,
  // which act on the exact file:line a CI log names. The older runtime fixers
  // rewrite whole files (every Promise.all, every `.prop`, TS syntax injected
  // into plain .js) — they now see CI/config files only, or, where the rewrite
  // preserves behaviour, only the source files the logs actually point at.
  const referencedSources = logReferencedSourcePaths(logs, 50);
  const isReferenced = (p: string) =>
    referencedSources.some(r => r === p || r.endsWith(`/${p}`) || p.endsWith(`/${r}`));
  const ciSnap = () => snap().filter(f => !isAppSourceFile(f.path));
  const referencedSnap = () => snap().filter(f => !isAppSourceFile(f.path) || isReferenced(f.path));

  // ════════════════════════════════════════════════════════════════════════
  // SIMPLE — always-run rules (file-content based, safe for any category)
  // ════════════════════════════════════════════════════════════════════════
  staticRule(fixYamlTabIndentation);
  staticRule(fixYamlIndentationDepth);
  staticRule(fixDuplicateYamlKey);
  applyBatch(fixMissingYamlColon(logs, snap()));
  staticRule(fixIncorrectYamlBooleans);
  staticRule(fixIncorrectExpressionDelimiter);
  staticRule(fixStepUsesAndRun);
  staticRule(fixMissingWorkflowTrigger);
  staticRule(fixWorkflowTriggerTypo);
  staticRule(fixIncorrectConfigHierarchy);
  staticRule(fixMissingShebang);
  staticRule(fixAptGetSudo);
  staticRule(fixNpmCacheNolockfile);
  staticRule(fixNpmCiToInstall);
  staticRule(fixCodecovNonBlocking);
  staticRule(fixArtifactIfNoFilesError);
  staticRule(fixGradleWrapperPermission);
  staticRule(fixPnpmWorkspaceBuild);
  staticRule(fixCargoWorkspaceBuild);
  staticRule(fixNextJsBuildConfig);
  staticRule(fixPython2to3);
  staticRule(fixRustToolchainFile);
  staticRule(fixPrismaGenerate);
  staticRule(fixGoGenerateStep);
  applyBatch(fixLernaBootstrap(logs, snap()));
  staticRule(fixMakeParallelJobs);
  staticRule(fixTailwindContentPaths);
  staticRule(fixSvelteKitAdapter);
  staticRule(fixRakeTask);
  applyBatch(fixRubyNativeExtensions(logs, snap()));
  applyBatch(fixFlutterSDKConstraint(logs, snap()));
  staticRule(fixMissingNodeEnv);
  staticRule(fixMissingCIEnvFlag);
  staticRule(fixPromoteRepeatedEnvVars);
  staticRule(fixVariableScopeIssue);
  staticRule(fixAddInstallStep);
  staticRule(fixMissingYarnInstallStep);
  staticRule(fixMissingComposerInstall);
  staticRule(fixMissingPoetryInstall);
  staticRule(fixMissingPipenvInstall);
  staticRule(fixMissingSetupPython);
  staticRule(fixMissingSetupJava);
  staticRule(fixMissingSetupGo);
  staticRule(fixCondaEnvironmentSetup);
  staticRule(fixNpmEnginesCheck);
  staticRule(fixNvmrcVersionMismatch);
  staticRule(fixNpmCacheRestoreKeys);
  staticRule(fixPipCache);
  staticRule(fixMavenCache);
  staticRule(fixGradleCache);
  staticRule(fixComposerCache);
  staticRule(fixGoModCache);
  staticRule(fixCreateRequirementsTxt);
  staticRule(fixRequirementsPinning);
  staticRule(fixPipNoCacheDir);
  staticRule(fixNpmRegistryAuth);
  staticRule(fixPipPrivateIndex);
  staticRule(fixCreateDotEnvExample);
  // NEW always-run: syntax + environment + deps + build
  staticRule(fixRunnerLabelTypo);
  staticRule(fixMissingCheckoutStep);
  staticRule(fixInvalidCronExpression);
  staticRule(fixGitLabOnlyExceptToRules);
  staticRule(fixMultilineRunScript);
  staticRule(fixMissingWorkflowCallTrigger);
  staticRule(fixLinuxCommandsOnWindows);
  staticRule(fixBashSyntaxInPosixSh);
  staticRule(fixHardcodedSecretInYaml);
  staticRule(fixTerraformEnvVars);
  staticRule(fixDeprecatedSaveState);
  staticRule(fixMissingGitHubTokenPermissions);
  staticRule(fixGitLabVariableMasking);
  staticRule(fixIncorrectNodeEnvValue);
  staticRule(fixDotEnvInGitignore);
  staticRule(fixUndeclaredEnvVarReference);
  staticRule(fixMissingNpmPublishToken);
  staticRule(fixMissingDockerRegistrySecrets);
  staticRule(fixMissingAwsRegion);
  staticRule(fixPythonEnvVars);
  staticRule(fixJavaEnvVars);
  staticRule(fixGoEnvVars);
  staticRule(fixCargoEnvVars);
  staticRule(fixStepOutputScopeError);
  staticRule(fixMissingJobOutputsDeclaration);
  staticRule(fixEventInputScope);
  staticRule(fixDotNetEnvVars);
  staticRule(fixRubyEnvVars);
  staticRule(fixPhpEnvVars);
  staticRule(fixGoogleCloudEnvVars);
  staticRule(fixAzureEnvVars);
  staticRule(fixVercelDeployEnvVars);
  staticRule(fixSentryEnvVars);
  staticRule(fixSecretsInheritance);
  staticRule(fixExportVarCrossStep);
  staticRule(fixMissingSecretsContextUsage);
  staticRule(fixHuskyCI);
  staticRule(fixMavenWrapperPermission);
  staticRule(fixYarnBerrySetup);
  staticRule(fixMissingEditorConfig);
  staticRule(fixArtifactRetentionDays);
  staticRule(fixRetentionDaysType);
  staticRule(fixDenyLicensesType);
  staticRule(fixContentsNonePermission);
  staticRule(fixQuotedExpressionLiteral);
  staticRule(fixExternalServiceJobNonBlocking);
  staticRule(fixFailFastMatrix);
  staticRule(fixGitLabMissingCache);

  // ════════════════════════════════════════════════════════════════════════
  // INTERMEDIATE — always-run pipeline + git hygiene rules
  // ════════════════════════════════════════════════════════════════════════
  staticRule(fixDeprecatedSetOutput);
  staticRule(fixDeprecatedSetEnv);
  staticRule(fixMergeConflictMarkers);
  staticRule(fixGitLabStageOrder);
  staticRule(fixGitLabOptionalStages);
  staticRule(fixMissingJobNeeds);
  staticRule(fixSecurityJobNonBlocking);
  staticRule(fixMissingReportsDir);
  staticRule(fixMissingDispatchInputs);
  staticRule(fixGitLabIncludePath);
  // NEW always-run: git + pipeline + config hygiene
  staticRule(fixHuskyPreCommitCI);
  staticRule(fixMissingJobOutputs);
  staticRule(fixRecursivePipelineTrigger);
  applyBatch(fixGitLineEndings(logs, snap()));
  staticRule(fixGitLabDefaultBranch);
  // Config always-run
  staticRule(fixMissingWorkflowName);
  staticRule(fixIfAlwaysSyntax);
  staticRule(fixWorkflowIfCondition);
  staticRule(fixStepUsesAndRunConflict);
  staticRule(fixDuplicateEnvKey);
  staticRule(fixDuplicatePermissions);
  staticRule(fixDockerComposeVersionField);
  staticRule(fixGitLabWorkflowRules);
  staticRule(fixGitLabResourceGroup);
  staticRule(fixGitLabEnvironmentConfig);
  staticRule(fixGitLabRulesNeverMatch);
  staticRule(fixMissingDockerignore);
  staticRule(fixDockerMissingDockerignore);
  staticRule(fixMissingSecretsContext);
  staticRule(fixSecretToEnvMapping);
  staticRule(fixEnvContextScope);
  staticRule(fixReusableWorkflowPin);
  // Pipeline always-run
  staticRule(fixConcurrencyForPR);
  staticRule(fixPullRequestTargetSecurity);
  staticRule(fixPushTagsPattern);
  staticRule(fixPathFilterTrigger);
  staticRule(fixArtifactIfNoFilesFound);
  staticRule(fixCacheRestoreKeys);
  staticRule(fixSetupActionBuiltinCache);
  staticRule(fixCacheKeyHashFiles);
  staticRule(fixGitLabArtifactConfig);
  staticRule(fixGitLabCachePolicy);
  staticRule(fixWorkflowDispatchInputs);
  staticRule(fixJobOrderingWithNeeds);
  applyBatch(fixDanglingNeedsReference(logs, snap()));
  staticRule(fixNeedsContextKeyMismatch);
  staticRule(fixWrongResultValueInIf);
  staticRule(fixMatrixNodeVersionKey);
  staticRule(fixMissingStepIdForOutput);
  staticRule(fixSonarCloudConfig);
  staticRule(fixPostgresServiceConfig);
  staticRule(fixBarrierGateJob);
  staticRule(fixWorkflowLevelEnvSharing);

  // Runtime always-run
  applyBatch(fixStrictNullChecks(logs, snap()));
  applyBatch(fixImplicitAnyError(logs, snap()));
  applyBatch(fixTypeCheckBeforeBuild(logs, snap()));
  applyBatch(fixCIInfiniteLoopKill(logs, snap()));
  applyBatch(fixMochaForceExit(logs, snap()));
  applyBatch(fixPlaywrightPageTimeout(logs, snap()));
  applyBatch(fixJVMHeapConfig(logs, snap()));
  applyBatch(fixGradleJVMArgs(logs, snap()));
  applyBatch(fixSwapSpaceCI(logs, snap()));
  applyBatch(fixAsyncTryCatch(logs, snap()));

  // Advanced always-run rules
  staticRule(fixMissingDockerignore);
  staticRule(fixDockerMissingDockerignore);
  staticRule(fixDockerBaseImagePin);
  staticRule(fixEnableDockerBuildKit);
  staticRule(fixSlackNotificationSecret);
  staticRule(fixGitLabDeployEnvironment);
  staticRule(fixSSHDeployNonBlocking);
  staticRule(fixK8sRolloutWait);

  // ════════════════════════════════════════════════════════════════════════
  // CATEGORY-SPECIFIC rules — targeted at the diagnosed failure type
  // ════════════════════════════════════════════════════════════════════════

  if (hasCategory('docker_auth')) {
    categoryRule(fixDockerJobOnPushOnly);
    categoryRule(fixDockerAndDeployJobsNonBlocking);
    categoryRule(fixCreateMinimalDockerfile);
    categoryRule(fixGitLabDockerJobGuard);
    applyBatch(fixDockerHubTokenExpiry(logs, snap()));
    applyBatch(fixPackagesWritePermission(logs, snap()));
    applyBatch(fixPackagesReadPermission(logs, snap()));
    applyBatch(fixGHCRCrossOrgPackageRead(logs, snap()));
    applyBatch(fixAzureContainerRegistryAuth(logs, snap()));
    applyBatch(fixGoogleArtifactRegistryAuth(logs, snap()));
    applyBatch(fixECRCrossAccountAccess(logs, snap()));
    applyBatch(fixECRRepositoryCrossAccountPolicy(logs, snap()));
    // Extended registry auth
    applyBatch(fixDockerGHCRLogin(logs, snap()));
    applyBatch(fixDockerECRLogin(logs, snap()));
    applyBatch(fixDockerACRLoginStep(logs, snap()));
    applyBatch(fixDockerGARLoginStep(logs, snap()));
    applyBatch(fixDockerHubAccessToken(logs, snap()));
    applyBatch(fixDockerPrivateRegistryCA(logs, snap()));
    categoryRule(fixDockerCredentialHelper);
  }

  if (hasCategory('docker_rate_limit')) {
    applyBatch(fixDockerHubRateLimit(logs, snap()));
    categoryRule(fixDockerJobOnPushOnly);
  }

  if (hasCategory('docker_build')) {
    categoryRule(fixCreateMinimalDockerfile);
    categoryRule(fixDockerBaseImagePin);
    categoryRule(fixDockerPortExpose);
    applyBatch(fixMissingDockerLayer(logs, snap()));
    applyBatch(fixDockerImagePullFailure(logs, snap()));
    // Section A — Build failure extended
    applyBatch(fixDockerBuildContextTooLarge(logs, snap()));
    applyBatch(fixDockerBuildArgMissing(logs, snap()));
    applyBatch(fixDockerMultiStageBuild(logs, snap()));
    categoryRule(fixDockerRUNLayerMerge);
    categoryRule(fixDockerAPTGetUpdate);
    categoryRule(fixDockerNPMInstallProd);
    categoryRule(fixDockerPipNoCacheDir);
    categoryRule(fixDockerCopyOrderForCache);
    categoryRule(fixDockerShellToExecForm);
    applyBatch(fixDockerBuildPlatformArg(logs, snap()));
    applyBatch(fixDockerQEMUSetup(logs, snap()));
    categoryRule(fixDockerLayerCleanup);
    // Section B — Layer cache
    categoryRule(fixDockerGHACacheMount);
    categoryRule(fixDockerRegistryLayerCache);
    applyBatch(fixDockerManifestUnknown(logs, snap()));
    applyBatch(fixDockerPullRetryOnBlob(logs, snap()));
    categoryRule(fixDockerBuildKitCacheMount);
    categoryRule(fixDockerSetupBuildx);
    categoryRule(fixDockerMetadataAction);
    categoryRule(fixDockerServicePullPolicy);
  }

  if (hasCategory('missing_docker_layer')) {
    applyBatch(fixMissingDockerLayer(logs, snap()));
    categoryRule(fixDockerGHACacheMount);
    categoryRule(fixDockerRegistryLayerCache);
    applyBatch(fixDockerManifestUnknown(logs, snap()));
    applyBatch(fixDockerPullRetryOnBlob(logs, snap()));
    categoryRule(fixDockerBuildKitCacheMount);
    categoryRule(fixDockerSetupBuildx);
    categoryRule(fixDockerMetadataAction);
    categoryRule(fixDockerServicePullPolicy);
  }

  if (hasCategory('dockerfile_syntax')) {
    applyBatch(fixDockerfileHeredocSyntax(logs, snap()));
    applyBatch(fixDockerfileEnvVsArg(logs, snap()));
    categoryRule(fixDockerfileCmdEntrypointInteraction);
    applyBatch(fixDockerfileJSONArraySyntax(logs, snap()));
    categoryRule(fixDockerfileAddVsCopy);
    categoryRule(fixDockerfileWorkdirAbsolute);
    categoryRule(fixDockerfileLabelFormat);
    categoryRule(fixDockerfileNonRootUser);
    categoryRule(fixDockerignoreSecrets);
    applyBatch(fixDockerfileWildcardCopy(logs, snap()));
  }

  if (hasCategory('container_startup')) {
    categoryRule(fixDockerTiniInit);
    categoryRule(fixDockerEntrypointEnvCheck);
    applyBatch(fixDockerWaitForDependencies(logs, snap()));
    categoryRule(fixDockerStopSignal);
    categoryRule(fixDockerTimezone);
    applyBatch(fixDockerUlimits(logs, snap()));
    applyBatch(fixDockerResourceLimits(logs, snap()));
    applyBatch(fixDockerRestartPolicy(logs, snap()));
    categoryRule(fixDockerLoggingConfig);
    categoryRule(fixDockerStartupHealthcheck);
  }

  if (hasCategory('container_health_failure')) {
    applyBatch(fixDockerHealthcheck(logs, snap()));
    applyBatch(fixWaitForDatabase(logs, snap()));
    categoryRule(fixDockerStartupHealthcheck);
    applyBatch(fixDockerWaitForDependencies(logs, snap()));
    categoryRule(fixDockerTiniInit);
  }

  if (hasCategory('registry_auth_failure')) {
    applyBatch(fixDockerGHCRLogin(logs, snap()));
    applyBatch(fixDockerECRLogin(logs, snap()));
    applyBatch(fixDockerACRLoginStep(logs, snap()));
    applyBatch(fixDockerGARLoginStep(logs, snap()));
    applyBatch(fixDockerHubAccessToken(logs, snap()));
    applyBatch(fixDockerPrivateRegistryCA(logs, snap()));
    categoryRule(fixDockerCredentialHelper);
    applyBatch(fixDockerHubRateLimit(logs, snap()));
  }

  if (hasCategory('volume_mount_failure')) {
    categoryRule(fixDockerNamedVolumes);
    applyBatch(fixDockerVolumeSelinuxLabel(logs, snap()));
    applyBatch(fixDockerBindMountAbsolutePath(logs, snap()));
    categoryRule(fixDockerVolumeReadOnly);
    applyBatch(fixDockerTmpfsMount(logs, snap()));
    applyBatch(fixDockerNFSVolumeOptions(logs, snap()));
    applyBatch(fixDockerVolumeDriverConfig(logs, snap()));
    categoryRule(fixDockerComposeInit);
    applyBatch(fixDockerVolumePermissions(logs, snap()));
  }

  if (hasCategory('missing_file')) {
    categoryRule(fixCreateMinimalDockerfile);
    applyBatch(fixMissingTsConfig(logs, snap()));
    applyBatch(fixConfigMissingTsConfig(logs, snap()));
    applyBatch(fixMissingBuildScript(logs, snap()));
  }

  if (hasCategory('permission_denied')) {
    applyBatch(fixChmodScript(logs, snap()));
    applyBatch(fixDockerVolumePermissions(logs, snap()));
  }

  if (hasCategory('permissions_error')) {
    applyBatch(fixMissingPermissions(logs, snap()));
    applyBatch(fixAdvancedOidc(logs, snap()));
  }

  if (hasCategory('oidc_failure')) {
    applyBatch(fixAdvancedOidc(logs, snap()));
    applyBatch(fixOidcPermission(logs, snap()));
  }

  if (hasCategory('invalid_token')) {
    applyBatch(fixExpiredToken(logs, snap()));
    applyBatch(fixNpmPrivateRegistry(logs, snap()));
    // Section A — Invalid access token
    applyBatch(fixMissingBearerPrefix(logs, snap()));
    applyBatch(fixGitHubTokenScopes(logs, snap()));
    applyBatch(fixSAMLSSOTokenAuth(logs, snap()));
    applyBatch(fixFineGrainedPATAccess(logs, snap()));
    applyBatch(fixWrongSecretReference(logs, snap()));
    applyBatch(fixAzureServicePrincipalAuth(logs, snap()));
    applyBatch(fixGCPWorkloadIdentityAuth(logs, snap()));
    applyBatch(fixAWSSTSAssumeRole(logs, snap()));
    applyBatch(fixGitHubAppInstallationToken(logs, snap()));
    applyBatch(fixAPIKeyQueryToHeader(logs, snap()));
    // Section B — Expired token
    applyBatch(fixTokenValidationPreflight(logs, snap()));
    applyBatch(fixNPMTokenExpiry(logs, snap()));
    applyBatch(fixDockerHubTokenExpiry(logs, snap()));
    applyBatch(fixAWSCredentialOIDCUpgrade(logs, snap()));
    applyBatch(fixGCPSAKeyRefresh(logs, snap()));
    applyBatch(fixHerokuAPIKeyRotation(logs, snap()));
    applyBatch(fixAtlassianAPITokenExpiry(logs, snap()));
    applyBatch(fixTerraformCloudTokenRenewal(logs, snap()));
  }

  if (hasCategory('ssh_key_error')) {
    applyBatch(fixSSHKnownHosts(logs, snap()));
    applyBatch(fixAdvancedSSHKnownHosts(logs, snap()));
    categoryRule(fixSSHDeployNonBlocking);
    applyBatch(fixSSHKeyFormatEd25519(logs, snap()));
    applyBatch(fixSSHAgentSocketForwarding(logs, snap()));
    applyBatch(fixSSHDeployKeyWriteAccess(logs, snap()));
    applyBatch(fixSSHKeyPassphraseCI(logs, snap()));
    applyBatch(fixSSHHostKeyAlgorithmMismatch(logs, snap()));
    applyBatch(fixSSHMultipleHostsKeyscan(logs, snap()));
    applyBatch(fixSSHKeyFilePermissions600(logs, snap()));
    applyBatch(fixGitLabDeployKeyWriteAccess(logs, snap()));
    applyBatch(fixSSHJumpHostConfig(logs, snap()));
  }

  if (hasCategory('permission_denied')) {
    applyBatch(fixContentsWritePermission(logs, snap()));
    applyBatch(fixPackagesWritePermission(logs, snap()));
    applyBatch(fixPackagesReadPermission(logs, snap()));
    applyBatch(fixPullRequestsWritePermission(logs, snap()));
    applyBatch(fixIssuesWritePermission(logs, snap()));
    applyBatch(fixChecksWritePermission(logs, snap()));
    applyBatch(fixPagesDeployPermission(logs, snap()));
    applyBatch(fixDeploymentsWritePermission(logs, snap()));
    applyBatch(fixSecurityEventsWritePermission(logs, snap()));
    applyBatch(fixActionsReadPermission(logs, snap()));
    applyBatch(fixWorkflowPermissionsBlock(logs, snap()));
    applyBatch(fixGitLabProtectedBranchPushGuard(logs, snap()));
  }

  if (hasCategory('oauth_failure')) {
    applyBatch(fixOAuthRedirectURIMismatch(logs, snap()));
    applyBatch(fixOAuthMissingScopes(logs, snap()));
    applyBatch(fixOAuthCSRFState(logs, snap()));
    applyBatch(fixGitHubOAuthAppConfig(logs, snap()));
    applyBatch(fixGoogleOAuthServiceAccount(logs, snap()));
    applyBatch(fixOAuthCallbackURLEnvVar(logs, snap()));
    applyBatch(fixOAuthPKCEVerifier(logs, snap()));
    applyBatch(fixOAuthTokenStorage(logs, snap()));
  }

  if (hasCategory('secret_access_denied')) {
    applyBatch(fixEnvironmentSecretDeclaration(logs, snap()));
    applyBatch(fixForkPRSecretsUnavailable(logs, snap()));
    applyBatch(fixOrganizationSecretRepositoryAccess(logs, snap()));
    applyBatch(fixBranchRestrictedSecretAccess(logs, snap()));
    applyBatch(fixRequiredSecretPresenceCheck(logs, snap()));
    applyBatch(fixGitLabProtectedVariableAccess(logs, snap()));
    applyBatch(fixPullRequestTargetForForkSecrets(logs, snap()));
    applyBatch(fixHashiCorpVaultTokenRenewal(logs, snap()));
  }

  if (hasCategory('insufficient_role')) {
    applyBatch(fixAWSIAMPermissionDiagnostic(logs, snap()));
    applyBatch(fixGCPIAMRoleBinding(logs, snap()));
    applyBatch(fixAzureRBACRoleAssignment(logs, snap()));
    applyBatch(fixKubernetesClusterRoleBinding(logs, snap()));
    applyBatch(fixTerraformStateBucketPermissions(logs, snap()));
    applyBatch(fixGitHubOIDCTrustPolicy(logs, snap()));
    applyBatch(fixECRRepositoryCrossAccountPolicy(logs, snap()));
    applyBatch(fixCloudRunServiceAccountInvoker(logs, snap()));
  }

  if (hasCategory('cross_project_access')) {
    applyBatch(fixCrossRepoCheckoutWithPAT(logs, snap()));
    applyBatch(fixGitLabGroupAccessToken(logs, snap()));
    applyBatch(fixPrivateSubmoduleTokenAuth(logs, snap()));
    applyBatch(fixGHCRCrossOrgPackageRead(logs, snap()));
    applyBatch(fixECRCrossAccountAccess(logs, snap()));
    applyBatch(fixGitLabCrossGroupCITrigger(logs, snap()));
    applyBatch(fixGoogleArtifactRegistryAuth(logs, snap()));
    applyBatch(fixAzureContainerRegistryAuth(logs, snap()));
    applyBatch(fixGitLabCrossProjectToken(logs, snap()));
    applyBatch(fixAdvancedGitLabCrossProjectToken(logs, snap()));
  }

  if (hasCategory('node_version')) {
    applyBatch(fixNodeVersionPin(logs, snap()));
  }

  if (hasCategory('missing_dependency')) {
    applyBatch(fixMissingPnpmSetup(logs, snap()));
    categoryRule(fixMissingSetupPython);
    categoryRule(fixMissingSetupJava);
    categoryRule(fixMissingSetupGo);
    categoryRule(fixMissingComposerInstall);
    categoryRule(fixMissingPoetryInstall);
    categoryRule(fixMissingPipenvInstall);
    applyBatch(fixPeerDepConflict(logs, snap()));
    applyBatch(fixNpmOverrides(logs, snap()));
    applyBatch(fixYarnResolutions(logs, snap()));
    applyBatch(fixYarnFrozenLockfile(logs, snap()));
    applyBatch(fixPipDependencyConflict(logs, snap()));
    applyBatch(fixPipIgnoreRequiresPython(logs, snap()));
    applyBatch(fixMavenDependencyConflict(logs, snap()));
    categoryRule(fixPipNoCacheDir);
    applyBatch(fixPipUpgrade(logs, snap()));
    applyBatch(fixCorruptedLockfile(logs, snap()));
    applyBatch(fixYarnLockfileCorruption(logs, snap()));
    applyBatch(fixPoetryLockfileCorruption(logs, snap()));
    applyBatch(fixGemfileLockCorruption(logs, snap()));
    applyBatch(fixPnpmLockfileCorruption(logs, snap()));
    applyBatch(fixMissingVirtualEnv(logs, snap()));
    applyBatch(fixPoetryVirtualEnv(logs, snap()));
    categoryRule(fixCondaEnvironmentSetup);
    applyBatch(fixNodeVersionPin(logs, snap()));
    applyBatch(fixUnsupportedEngineVersion(logs, snap()));
    applyBatch(fixPythonVersionPin(logs, snap()));
    applyBatch(fixJavaVersionPin(logs, snap()));
    applyBatch(fixGoVersionPin(logs, snap()));
    applyBatch(fixRubyVersionPin(logs, snap()));
    applyBatch(fixDeprecatedNpmDependency(logs, snap()));
  }

  if (hasCategory('python_deps')) {
    applyBatch(fixPipUpgrade(logs, snap()));
    categoryRule(fixPipNoCacheDir);
    applyBatch(fixPythonPath(logs, snap()));
    categoryRule(fixCreateRequirementsTxt);
  }

  if (hasCategory('env_missing')) {
    applyBatch(fixOptionalSecretSteps(logs, snap()));
    applyBatch(fixEnvVarWithDefault(logs, snap()));
    applyBatch(fixGitLabMissingVariables(logs, snap()));
    categoryRule(fixCreateDotEnvExample);
    categoryRule(fixMissingAwsRegion);
    categoryRule(fixPythonEnvVars);
    categoryRule(fixJavaEnvVars);
    categoryRule(fixGoEnvVars);
    categoryRule(fixCargoEnvVars);
    categoryRule(fixUndeclaredEnvVarReference);
    categoryRule(fixStepOutputScopeError);
    categoryRule(fixMissingJobOutputsDeclaration);
    categoryRule(fixEventInputScope);
  }

  if (hasCategory('build_failure')) {
    // Category 1: Build script failure
    applyBatch(fixMissingBuildScript(logs, snap()));
    categoryRule(fixGradleWrapperPermission);
    applyBatch(fixGradleDaemonOOM(logs, snap()));
    categoryRule(fixMavenBuildScript);
    applyBatch(fixTurboPipelineConfig(logs, snap()));
    applyBatch(fixNxBuildSetup(logs, snap()));
    categoryRule(fixPnpmWorkspaceBuild);
    categoryRule(fixCargoWorkspaceBuild);
    applyBatch(fixAndroidGradleBuild(logs, snap()));
    applyBatch(fixShellScriptExitCodes(logs, snap()));
    // Category 2: Compilation failure
    applyBatch(fixCompilationFailure(logs, snap()));
    applyBatch(fixMissingTsConfig(logs, snap()));
    applyBatch(fixConfigMissingTsConfig(logs, snap()));
    applyBatch(fixTypeScriptPathAlias(logs, snap()));
    applyBatch(fixESMCJSConflict(logs, snap()));
    applyBatch(fixJavaCompilationError(logs, snap()));
    applyBatch(fixGoCompilationError(logs, snap()));
    applyBatch(fixRustCompilationError(logs, snap()));
    applyBatch(fixDotNetCompilationError(logs, snap()));
    applyBatch(fixBabelPresetConfig(logs, snap()));
    applyBatch(fixSassMigration(logs, snap()));
    applyBatch(fixKotlinJvmTarget(logs, snap()));
    // Category 3: Missing build artifact
    applyBatch(fixMissingOutputDirectory(logs, snap()));
    applyBatch(fixArtifactOutputPath(logs, snap()));
    applyBatch(fixGradleArtifactPath(logs, snap()));
    applyBatch(fixMavenArtifactPath(logs, snap()));
    categoryRule(fixRustBinaryArtifact);
    categoryRule(fixDotNetPublishArtifact);
    categoryRule(fixGoArtifactPath);
    categoryRule(fixNextExportArtifact);
    categoryRule(fixDockerSaveArtifact);
    // Category 4: Invalid build target
    applyBatch(fixInvalidBuildTarget(logs, snap()));
    applyBatch(fixGradleTaskNotFound(logs, snap()));
    applyBatch(fixMavenGoalNotFound(logs, snap()));
    applyBatch(fixNpmWorkspaceScript(logs, snap()));
    applyBatch(fixTurboMissingTask(logs, snap()));
    applyBatch(fixBazelBuildTarget(logs, snap()));
    // Category 5: Unsupported runtime version
    applyBatch(fixNodeExperimentalFlags(logs, snap()));
    categoryRule(fixPython2to3);
    applyBatch(fixJavaReleaseFlag(logs, snap()));
    categoryRule(fixRustToolchainFile);
    applyBatch(fixDotNetTargetFramework(logs, snap()));
    applyBatch(fixGoModDirective(logs, snap()));
    applyBatch(fixSwiftToolsVersion(logs, snap()));
    categoryRule(fixOpenSSLLegacyProvider);
    applyBatch(fixRubyKeywordArgs(logs, snap()));
    applyBatch(fixPHPVersionCompat(logs, snap()));
    applyBatch(fixRubyNativeExtensions(logs, snap()));
    applyBatch(fixFlutterSDKConstraint(logs, snap()));
    // Extended Category 1
    categoryRule(fixPrismaGenerate);
    categoryRule(fixGoGenerateStep);
    applyBatch(fixLernaBootstrap(logs, snap()));
    categoryRule(fixCMakeBuildSetup);
    categoryRule(fixMakeParallelJobs);
    categoryRule(fixProtobufGenerate);
    categoryRule(fixDockerComposeBuildService);
    // Extended Category 2
    categoryRule(fixGraphQLCodegen);
    categoryRule(fixTailwindContentPaths);
    applyBatch(fixAngularBuildBudget(logs, snap()));
    categoryRule(fixSvelteKitAdapter);
    applyBatch(fixPostCSSConfig(logs, snap()));
    categoryRule(fixNuxtNitroPreset);
    // Extended Category 3
    categoryRule(fixLambdaZipPackage);
    categoryRule(fixNuGetPackageOutput);
    categoryRule(fixHelmChartPackage);
    categoryRule(fixElectronArtifactPath);
    categoryRule(fixPythonWheelBuild);
    // Extended Category 4
    categoryRule(fixRakeTask);
    applyBatch(fixMixTask(logs, snap()));
    applyBatch(fixSbtBuildTask(logs, snap()));
    // Cross-category
    applyBatch(fixPythonPath(logs, snap()));
    applyBatch(fixIncorrectFilePath(logs, snap()));
    applyBatch(fixInvalidJsonSyntax(logs, snap()));
    applyBatch(fixScriptTypo(logs, snap()));
    applyBatch(fixIncorrectVariableName(logs, snap()));
    applyBatch(fixShallowCloneFetchDepth(logs, snap()));
    applyBatch(fixGitShallowCloneFetchDepth(logs, snap()));
  }

  if (hasCategory('compilation_failure')) {
    applyBatch(fixCompilationFailure(logs, snap()));
    applyBatch(fixMissingTsConfig(logs, snap()));
    applyBatch(fixConfigMissingTsConfig(logs, snap()));
    applyBatch(fixTypeScriptPathAlias(logs, snap()));
    applyBatch(fixESMCJSConflict(logs, snap()));
    applyBatch(fixJavaCompilationError(logs, snap()));
    applyBatch(fixGoCompilationError(logs, snap()));
    applyBatch(fixRustCompilationError(logs, snap()));
    applyBatch(fixDotNetCompilationError(logs, snap()));
    applyBatch(fixBabelPresetConfig(logs, snap()));
    applyBatch(fixSassMigration(logs, snap()));
    applyBatch(fixKotlinJvmTarget(logs, snap()));
    applyBatch(fixTypeMismatch(logs, snap()));
  }

  if (hasCategory('artifact_missing')) {
    applyBatch(fixMissingOutputDirectory(logs, snap()));
    applyBatch(fixArtifactOutputPath(logs, snap()));
    categoryRule(fixArtifactIfNoFilesError);
    applyBatch(fixGradleArtifactPath(logs, snap()));
    applyBatch(fixMavenArtifactPath(logs, snap()));
    categoryRule(fixRustBinaryArtifact);
    categoryRule(fixDotNetPublishArtifact);
    categoryRule(fixGoArtifactPath);
    categoryRule(fixNextExportArtifact);
    categoryRule(fixDockerSaveArtifact);
  }

  if (hasCategory('gradle_build_failure')) {
    categoryRule(fixGradleWrapperPermission);
    applyBatch(fixGradleDaemonOOM(logs, snap()));
    applyBatch(fixGradleTaskNotFound(logs, snap()));
    applyBatch(fixGradleArtifactPath(logs, snap()));
    applyBatch(fixKotlinJvmTarget(logs, snap()));
    applyBatch(fixAndroidGradleBuild(logs, snap()));
    applyBatch(fixJavaReleaseFlag(logs, snap()));
  }

  if (hasCategory('maven_build_failure')) {
    categoryRule(fixMavenBuildScript);
    applyBatch(fixMavenGoalNotFound(logs, snap()));
    applyBatch(fixMavenArtifactPath(logs, snap()));
    applyBatch(fixJavaCompilationError(logs, snap()));
    applyBatch(fixJavaReleaseFlag(logs, snap()));
    categoryRule(fixDotnetRestore);
  }

  if (hasCategory('runtime_version_error')) {
    applyBatch(fixNodeExperimentalFlags(logs, snap()));
    categoryRule(fixPython2to3);
    applyBatch(fixJavaReleaseFlag(logs, snap()));
    categoryRule(fixRustToolchainFile);
    applyBatch(fixDotNetTargetFramework(logs, snap()));
    applyBatch(fixGoModDirective(logs, snap()));
    applyBatch(fixSwiftToolsVersion(logs, snap()));
  }

  if (hasCategory('memory_error')) {
    applyBatch(fixNodeHeapOOM(logs, snap()));
    applyBatch(fixNodeHeapMemory(logs, snap()));
    applyBatch(fixStackOverflow(logs, snap()));
    applyBatch(fixLinuxMemoryFragmentation(logs, snap()));
    applyBatch(fixPythonRecursionLimit(logs, snap()));
    applyBatch(fixOpenFilesLimit(logs, snap()));
    applyBatch(fixSegmentationFault(logs, snap()));
    applyBatch(fixNullReferenceException(logs, ciSnap()));
    applyBatch(fixJVMHeapConfig(logs, snap()));
    applyBatch(fixGradleJVMArgs(logs, snap()));
    applyBatch(fixGoMemoryTuning(logs, snap()));
    applyBatch(fixPythonMemoryLimit(logs, snap()));
    applyBatch(fixDockerMemoryLimit(logs, snap()));
    applyBatch(fixUlimitVirtualMemory(logs, snap()));
    applyBatch(fixK8sPodMemoryLimit(logs, snap()));
    applyBatch(fixSwapSpaceCI(logs, snap()));
  }

  if (hasCategory('null_reference')) {
    applyBatch(fixNullReferenceException(logs, ciSnap()));
    applyBatch(fixNullDerefOptionalChain(logs, ciSnap()));
    applyBatch(fixStrictNullChecks(logs, snap()));
    applyBatch(fixPythonNoneCheck(logs, snap()));
    applyBatch(fixGoNilPointerDeref(logs, snap()));
    applyBatch(fixRustUnwrapToExpect(logs, referencedSnap()));
    applyBatch(fixJavaNPEGuard(logs, snap()));
    applyBatch(fixCSharpNullConditional(logs, snap()));
    applyBatch(fixArrayBoundsCheck(logs, snap()));
    applyBatch(fixNullCoalescingEnvDefault(logs, snap()));
  }

  if (hasCategory('type_mismatch')) {
    applyBatch(fixTypeMismatch(logs, snap()));
    applyBatch(fixImplicitAnyError(logs, snap()));
    applyBatch(fixTypeCheckBeforeBuild(logs, snap()));
    applyBatch(fixPythonMypyCheck(logs, snap()));
    applyBatch(fixPyrightTypeCheck(logs, snap()));
    applyBatch(fixGoTypeAssertion(logs, snap()));
    applyBatch(fixRustTypeCast(logs, snap()));
    applyBatch(fixPHPStrictTypes(logs, snap()));
    applyBatch(fixRubySorbetTypeCheck(logs, snap()));
  }

  if (hasCategory('infinite_loop')) {
    applyBatch(fixCIInfiniteLoopKill(logs, snap()));
    applyBatch(fixLoopIterationGuard(logs, snap()));
    applyBatch(fixPythonTestHangTimeout(logs, snap()));
    applyBatch(fixJestTestHangTimeout(logs, snap()));
    applyBatch(fixMochaForceExit(logs, snap()));
    applyBatch(fixPlaywrightPageTimeout(logs, snap()));
    applyBatch(fixNodeEventListenerLeak(logs, ciSnap()));
    applyBatch(fixAsyncRetryMaxCap(logs, snap()));
    applyBatch(fixJobTimeout(logs, snap()));
    applyBatch(fixConfigJobTimeout(logs, snap()));
  }

  if (hasCategory('stack_overflow')) {
    applyBatch(fixStackOverflow(logs, snap()));
    applyBatch(fixJVMStackSize(logs, snap()));
    applyBatch(fixPythonConfTestRecursion(logs, snap()));
    applyBatch(fixPythonRecursionLimit(logs, snap()));
    applyBatch(fixRubyStackSize(logs, snap()));
    applyBatch(fixDotNetStackSize(logs, snap()));
    applyBatch(fixRustStackSize(logs, snap()));
    applyBatch(fixGoStackTrace(logs, snap()));
  }

  if (hasCategory('segfault')) {
    applyBatch(fixSegmentationFault(logs, snap()));
    applyBatch(fixAddressSanitizerBuild(logs, snap()));
    applyBatch(fixPythonFaultHandler(logs, snap()));
    applyBatch(fixRustMiriCheck(logs, snap()));
    applyBatch(fixValgrindMemCheck(logs, snap()));
    applyBatch(fixCoreDumpUpload(logs, snap()));
    applyBatch(fixNodeNativeAddonCrash(logs, snap()));
  }

  if (hasCategory('unhandled_exception')) {
    applyBatch(fixUnhandledRejection(logs, ciSnap()));
    applyBatch(fixAsyncTryCatch(logs, snap()));
    applyBatch(fixExpressErrorMiddleware(logs, ciSnap()));
    applyBatch(fixPromiseAllSettled(logs, ciSnap()));
    applyBatch(fixPythonExceptionLogging(logs, referencedSnap()));
    applyBatch(fixJavaUncaughtExceptionHandler(logs, snap()));
    applyBatch(fixDotNetUnhandledException(logs, snap()));
    applyBatch(fixSentryRuntimeCapture(logs, snap()));
    applyBatch(fixBrowserGlobalErrorHandler(logs, snap()));
    applyBatch(fixRuntimeExceptionDiagnostics(logs, snap()));
  }

  if (hasCategory('lint_failure')) {
    applyBatch(fixMissingEslintConfig(logs, snap()));
    applyBatch(fixCompilationFailure(logs, snap()));
    applyBatch(fixTypeMismatch(logs, snap()));
  }

  if (hasCategory('test_failure')) {
    categoryRule(fixJestCIFlag);
    // Unit test failures
    applyBatch(fixUnitTestFailure(logs, snap()));
    applyBatch(fixJestRunInBand(logs, snap()));
    applyBatch(fixJestForceExit(logs, snap()));
    applyBatch(fixFlakyTestRetry(logs, snap()));
    applyBatch(fixVitestRetry(logs, snap()));
    applyBatch(fixPytestRerunFails(logs, snap()));
    applyBatch(fixGoTestTimeout(logs, snap()));
    applyBatch(fixRustTestSerial(logs, snap()));
    applyBatch(fixDotNetTestLogger(logs, snap()));
    applyBatch(fixJestWorkerCount(logs, snap()));
    // Integration test failures
    applyBatch(fixIntegrationTestFailure(logs, snap()));
    applyBatch(fixDockerComposeTestUp(logs, snap()));
    applyBatch(fixTestContainersPull(logs, snap()));
    applyBatch(fixDatabaseMigrationBeforeTest(logs, snap()));
    applyBatch(fixKafkaServiceIntegration(logs, snap()));
    applyBatch(fixMinioServiceIntegration(logs, snap()));
    applyBatch(fixGRPCServiceHealth(logs, snap()));
    applyBatch(fixIntegrationTestRetry(logs, snap()));
    applyBatch(fixTestDatabaseIsolation(logs, snap()));
    applyBatch(fixWaitForServiceReady(logs, snap()));
    // Test environment
    applyBatch(fixTestEnvironmentMisconfig(logs, snap()));
    applyBatch(fixJestSetupFiles(logs, snap()));
    applyBatch(fixVitestSetupFiles(logs, snap()));
    applyBatch(fixJestTransformIgnore(logs, snap()));
    applyBatch(fixJestModuleExtensions(logs, snap()));
    applyBatch(fixPytestConftestSetup(logs, snap()));
    applyBatch(fixCypressConfig(logs, snap()));
    applyBatch(fixVitestAliasConfig(logs, snap()));
    applyBatch(fixJestCIOverrides(logs, snap()));
    // Mock failures
    applyBatch(fixEsmMockSupport(logs, snap()));
    applyBatch(fixMockModuleReset(logs, snap()));
    applyBatch(fixMockTimers(logs, snap()));
    applyBatch(fixModuleNameMapper(logs, snap()));
    applyBatch(fixPythonMockPatch(logs, snap()));
    applyBatch(fixNockHttpMocking(logs, snap()));
    applyBatch(fixVitestMockHoisting(logs, snap()));
    applyBatch(fixMockEnvVarSetup(logs, snap()));
    applyBatch(fixMSWSetup(logs, snap()));
    // General
    applyBatch(fixMissingTestScript(logs, snap()));
    applyBatch(fixNoTestFiles(logs, snap()));
    applyBatch(fixCreateMinimalTest(logs, snap()));
    applyBatch(fixMissingVitestConfig(logs, snap()));
    applyBatch(fixTestingMissingVitestConfig(logs, snap()));
    applyBatch(fixTestTimeout(logs, snap()));
    applyBatch(fixStaleMocks(logs, snap()));
    applyBatch(fixMissingDBService(logs, snap()));
    applyBatch(fixWaitForDatabase(logs, snap()));
  }

  if (hasCategory('coverage_failure')) {
    applyBatch(fixCoverageThreshold(logs, snap()));
    applyBatch(fixCoverageJSONReporter(logs, snap()));
    applyBatch(fixVitestCoverageProvider(logs, snap()));
    applyBatch(fixCodecovUploadStep(logs, snap()));
    applyBatch(fixCoverageArtifactUpload(logs, snap()));
    applyBatch(fixCoverageCollectAllFiles(logs, snap()));
    applyBatch(fixCoverageExcludeGenerated(logs, snap()));
    applyBatch(fixPerFileCoverageThreshold(logs, snap()));
    applyBatch(fixPytestCoverageConfig(logs, snap()));
    applyBatch(fixGitLabCoverageRegex(logs, snap()));
  }

  if (hasCategory('snapshot_mismatch')) {
    categoryRule(fixJestCIFlag);
    applyBatch(fixStaleMocks(logs, snap()));
    applyBatch(fixJestUpdateSnapshot(logs, snap()));
    applyBatch(fixSnapshotSerializer(logs, snap()));
    applyBatch(fixSnapshotDiffArtifact(logs, snap()));
    applyBatch(fixPlaywrightVisualBaseline(logs, snap()));
    applyBatch(fixInlineSnapshotFormat(logs, snap()));
    applyBatch(fixObsoleteSnapshots(logs, snap()));
    applyBatch(fixVitestUpdateSnapshot(logs, snap()));
    applyBatch(fixStorybookSnapshotTest(logs, snap()));
  }

  if (hasCategory('mock_failure')) {
    applyBatch(fixEsmMockSupport(logs, snap()));
    applyBatch(fixMockModuleReset(logs, snap()));
    applyBatch(fixMockTimers(logs, snap()));
    applyBatch(fixModuleNameMapper(logs, snap()));
    applyBatch(fixStaleMocks(logs, snap()));
    applyBatch(fixPythonMockPatch(logs, snap()));
    applyBatch(fixNockHttpMocking(logs, snap()));
    applyBatch(fixVitestMockHoisting(logs, snap()));
    applyBatch(fixMockEnvVarSetup(logs, snap()));
    applyBatch(fixMSWSetup(logs, snap()));
  }

  if (hasCategory('actions_deprecation')) {
    applyBatch(fixActionsVersionUpgrade(logs, snap()));
  }

  if (hasCategory('job_timeout')) {
    applyBatch(fixJobTimeout(logs, snap()));
    applyBatch(fixConfigJobTimeout(logs, snap()));
    categoryRule(fixParallelJobTimeouts);
    applyBatch(fixStepLevelTimeout(logs, snap()));
    applyBatch(fixGitLabJobTimeout(logs, snap()));
    applyBatch(fixHangingProcessWatchdog(logs, snap()));
  }

  if (hasCategory('concurrency_issue')) {
    categoryRule(fixMissingConcurrencyGroup);
    categoryRule(fixConcurrencyForPR);
    categoryRule(fixBarrierGateJob);
    categoryRule(fixMatrixFanInSummary);
  }

  if (hasCategory('pipeline_stage_failure')) {
    applyBatch(fixShellStrictMode(logs, snap()));
    applyBatch(fixPipelineStageFailureDiagnostic(logs, snap()));
    applyBatch(fixFlakyStageContinueOnError(logs, snap()));
    categoryRule(fixGitLabIncrementalPipeline);
    categoryRule(fixWorkflowRunWait);
    categoryRule(fixPipelineFailureNotification);
    applyBatch(fixMatrixIncludeExclude(logs, snap()));
    applyBatch(fixFailedPipelineStageRetry(logs, snap()));
  }

  if (hasCategory('stage_order_error')) {
    categoryRule(fixGitLabStageOrder);
    categoryRule(fixGitLabStageOrdering);
    categoryRule(fixGitLabDAGPipeline);
    applyBatch(fixDanglingNeedsReference(logs, snap()));
    categoryRule(fixJobOrderingWithNeeds);
    categoryRule(fixMissingJobNeeds);
  }

  if (hasCategory('invalid_trigger')) {
    categoryRule(fixPushBranchFilter);
    categoryRule(fixWorkflowDispatchInputs);
    categoryRule(fixPullRequestTargetSecurity);
    applyBatch(fixCronScheduleExpression(logs, snap()));
    categoryRule(fixWorkflowCallContract);
    categoryRule(fixPushTagsPattern);
    categoryRule(fixPathFilterTrigger);
  }

  if (hasCategory('runner_unavailable')) {
    categoryRule(fixParallelJobTimeouts);
    applyBatch(fixMissingRunner(logs, snap()));
    applyBatch(fixCircularDependency(logs, snap()));
    applyBatch(fixRunnerGroupFallback(logs, snap()));
    applyBatch(fixLargerRunnerSpec(logs, snap()));
    applyBatch(fixJobContainerImage(logs, snap()));
    applyBatch(fixOfflineRunnerContinue(logs, snap()));
  }

  if (hasCategory('artifact_upload_failure')) {
    applyBatch(fixArtifactUploadGlob(logs, snap()));
    categoryRule(fixArtifactIfNoFilesFound);
    applyBatch(fixMultipleArtifactUploads(logs, snap()));
    categoryRule(fixGitLabArtifactConfig);
    applyBatch(fixArtifactCompression(logs, snap()));
    applyBatch(fixS3ArtifactFallback(logs, snap()));
    categoryRule(fixArtifactRetentionDays);
    applyBatch(fixArtifactNameMismatch(logs, snap()));
  }

  if (hasCategory('cache_restore_failure')) {
    categoryRule(fixCacheRestoreKeys);
    applyBatch(fixCachePathMismatch(logs, snap()));
    categoryRule(fixSetupActionBuiltinCache);
    categoryRule(fixGitLabCachePolicy);
    categoryRule(fixCacheKeyHashFiles);
    applyBatch(fixCacheBust(logs, snap()));
    categoryRule(fixCacheKeyOverSpecific);
    categoryRule(fixGitLabMissingCache);
  }

  if (hasCategory('parallel_sync_issue')) {
    categoryRule(fixBarrierGateJob);
    categoryRule(fixDownloadAfterUpload);
    categoryRule(fixParallelJobOutputPaths);
    categoryRule(fixMatrixArtifactFanIn);
    categoryRule(fixConcurrencyForPR);
    categoryRule(fixMatrixFanInSummary);
    categoryRule(fixWorkflowLevelEnvSharing);
    categoryRule(fixFailFastMatrix);
  }

  if (hasCategory('git_merge_conflict')) {
    categoryRule(fixMergeConflictMarkers);
    applyBatch(fixMergeUnrelatedHistories(logs, snap()));
    applyBatch(fixGitRebasePullStrategy(logs, snap()));
    applyBatch(fixBinaryMergeDriver(logs, snap()));
    applyBatch(fixStashBeforePull(logs, snap()));
    applyBatch(fixCherryPickAbort(logs, snap()));
    applyBatch(fixGitMergeStrategyFlag(logs, snap()));
    applyBatch(fixDivergentBranchConfig(logs, snap()));
    categoryRule(fixRebaseBeforeMerge);
  }

  if (hasCategory('git_detached_head')) {
    applyBatch(fixGitLabDetachedHead(logs, snap()));
    applyBatch(fixGitHubActionsDetachedHead(logs, snap()));
    applyBatch(fixDetachedHeadCreateBranch(logs, snap()));
    applyBatch(fixCircleCIDetachedHead(logs, snap()));
    applyBatch(fixVersionBumpDetachedHead(logs, snap()));
    applyBatch(fixSHACheckoutToBranch(logs, snap()));
  }

  if (hasCategory('git_push_rejected')) {
    applyBatch(fixGitUserConfig(logs, snap()));
    applyBatch(fixGitHubActionsToken(logs, snap()));
    applyBatch(fixGitRemoteWithToken(logs, snap()));
    applyBatch(fixAdvancedGitRemoteWithToken(logs, snap()));
    applyBatch(fixMissingPermissions(logs, snap()));
    applyBatch(fixInvalidBranchReference(logs, snap()));
    applyBatch(fixRejectedCommit(logs, snap()));
    applyBatch(fixNonFastForwardPush(logs, snap()));
    applyBatch(fixSSHAgentForPush(logs, snap()));
    applyBatch(fixGitPushFollowTags(logs, snap()));
    applyBatch(fixGitPushAtomic(logs, snap()));
    categoryRule(fixGitHubPagesDeploy);
    applyBatch(fixLargeFilePush(logs, snap()));
    applyBatch(fixGitMirrorPush(logs, snap()));
  }

  if (hasCategory('git_commit_rejected')) {
    applyBatch(fixRejectedCommit(logs, snap()));
    applyBatch(fixCommitMessageLint(logs, snap()));
    applyBatch(fixSignedCommitSetup(logs, snap()));
    applyBatch(fixDisableSigningInCI(logs, snap()));
    applyBatch(fixProtectedBranchPAT(logs, snap()));
    categoryRule(fixRecursivePipelineTrigger);
    applyBatch(fixPreReceiveSecretHook(logs, snap()));
    applyBatch(fixGitHubAppTokenGen(logs, snap()));
  }

  if (hasCategory('git_access_denied')) {
    applyBatch(fixGitRemoteWithToken(logs, snap()));
    applyBatch(fixAdvancedGitRemoteWithToken(logs, snap()));
    applyBatch(fixSSHKnownHosts(logs, snap()));
    applyBatch(fixAdvancedSSHKnownHosts(logs, snap()));
    applyBatch(fixGitLabDeployKey(logs, snap()));
    applyBatch(fixGitHubAppTokenGen(logs, snap()));
    applyBatch(fixPrivateSubmoduleSSH(logs, snap()));
    applyBatch(fixGitHubEnterpriseBaseURL(logs, snap()));
    applyBatch(fixAzureDevOpsGitAuth(logs, snap()));
    applyBatch(fixPackageRegistryAuth(logs, snap()));
    applyBatch(fixSelfHostedRunnerGitAuth(logs, snap()));
    applyBatch(fixGitCredentialHelper(logs, snap()));
  }

  if (hasCategory('git_submodule_error')) {
    applyBatch(fixSubmoduleCheckout(logs, snap()));
    applyBatch(fixSubmoduleDeinit(logs, snap()));
    applyBatch(fixSubmoduleRelativeURL(logs, snap()));
    applyBatch(fixSubmoduleShallowClone(logs, snap()));
    applyBatch(fixSubmoduleBranchTracking(logs, snap()));
    applyBatch(fixSubmoduleUpdateInit(logs, snap()));
    applyBatch(fixNestedSubmoduleRecursive(logs, snap()));
    applyBatch(fixGitmodulesPath(logs, snap()));
    applyBatch(fixGitLabSubmoduleStrategy(logs, snap()));
  }

  if (hasCategory('git_lfs_error')) {
    applyBatch(fixGitLFSCheckout(logs, snap()));
  }

  if (hasCategory('git_invalid_branch')) {
    applyBatch(fixInvalidBranchReference(logs, snap()));
    applyBatch(fixDefaultBranchRename(logs, snap()));
    applyBatch(fixMissingUpstreamBranch(logs, snap()));
    applyBatch(fixStaleRemoteTracking(logs, snap()));
    applyBatch(fixBranchNameSanitize(logs, snap()));
    categoryRule(fixGitLabDefaultBranch);
    applyBatch(fixShallowClone(logs, snap()));
  }

  if (hasCategory('artifact_failure')) {
    applyBatch(fixArtifactNameMismatch(logs, snap()));
    applyBatch(fixArtifactOutputPath(logs, snap()));
    applyBatch(fixMissingOutputDirectory(logs, snap()));
  }

  if (hasCategory('cache_failure')) {
    categoryRule(fixCacheKeyOverSpecific);
    categoryRule(fixNpmCacheRestoreKeys);
  }

  if (hasCategory('runner_unavailable')) {
    categoryRule(fixParallelJobTimeouts);
    applyBatch(fixMissingRunner(logs, snap()));
    applyBatch(fixCircularDependency(logs, snap()));
  }

  if (hasCategory('deploy_failure')) {
    categoryRule(fixDeployRollbackOnFailure);
    categoryRule(fixSSHDeployNonBlocking);
    categoryRule(fixK8sRolloutWait);
    applyBatch(fixBlueGreenHealthCheck(logs, snap()));
    applyBatch(fixServiceUnavailable(logs, snap()));
    applyBatch(fixLoadBalancerRouting(logs, snap()));
    applyBatch(fixConnectionDraining(logs, snap()));
    applyBatch(fixCanaryDeployment(logs, snap()));
    // Extended rollback
    applyBatch(fixHelmRollbackOnFailure(logs, snap()));
    categoryRule(fixKubectlRollbackAnnotation);
    categoryRule(fixK8sRollbackHistoryLimit);
    applyBatch(fixHerokuReleaseRollback(logs, snap()));
    applyBatch(fixECSRollbackTaskDef(logs, snap()));
    applyBatch(fixCloudRunRollbackRevision(logs, snap()));
    applyBatch(fixAzureSlotRollback(logs, snap()));
    applyBatch(fixFlyioRollback(logs, snap()));
    applyBatch(fixGitLabDeployRollback(logs, snap()));
    applyBatch(fixDeployRollbackNotification(logs, snap()));
    // Production deploy gates
    categoryRule(fixConcurrentDeployPrevention);
    categoryRule(fixProdDeployBranchGuard);
    applyBatch(fixDeployTimeoutExtension(logs, snap()));
    applyBatch(fixPreDeploySmoke(logs, snap()));
  }

  if (hasCategory('rollback_failure')) {
    categoryRule(fixDeployRollbackOnFailure);
    applyBatch(fixHelmRollbackOnFailure(logs, snap()));
    categoryRule(fixKubectlRollbackAnnotation);
    categoryRule(fixK8sRollbackHistoryLimit);
    applyBatch(fixHerokuReleaseRollback(logs, snap()));
    applyBatch(fixECSRollbackTaskDef(logs, snap()));
    applyBatch(fixCloudRunRollbackRevision(logs, snap()));
    applyBatch(fixAzureSlotRollback(logs, snap()));
    applyBatch(fixFlyioRollback(logs, snap()));
    categoryRule(fixArgoRollbackSyncWave);
    applyBatch(fixTerraformDestroyGuard(logs, snap()));
    applyBatch(fixGitLabDeployRollback(logs, snap()));
    applyBatch(fixDeployRollbackNotification(logs, snap()));
  }

  if (hasCategory('failed_production_deploy')) {
    categoryRule(fixProdDeployGatingJob);
    categoryRule(fixConcurrentDeployPrevention);
    applyBatch(fixPreDeploySmoke(logs, snap()));
    applyBatch(fixDeployEnvValidation(logs, snap()));
    applyBatch(fixTerraformPlanBeforeApply(logs, snap()));
    applyBatch(fixHelmDryRunFirst(logs, snap()));
    if (hardening) applyBatch(fixK8sApplyValidation(logs, snap())); // validation step, not a repair
    applyBatch(fixDeployTimeoutExtension(logs, snap()));
    categoryRule(fixDockerImageHealthProbe);
    categoryRule(fixProdDeployBranchGuard);
    categoryRule(fixDeployTaggedRelease);
  }

  if (hasCategory('blue_green_conflict')) {
    applyBatch(fixBlueGreenHealthCheck(logs, snap()));
    applyBatch(fixBlueGreenK8sService(logs, snap()));
    applyBatch(fixBlueGreenALBTargetGroup(logs, snap()));
    applyBatch(fixBlueGreenDatabaseMigration(logs, snap()));
    applyBatch(fixBlueGreenSmoke(logs, snap()));
    applyBatch(fixBlueGreenRollback(logs, snap()));
    applyBatch(fixBlueGreenSessionDrain(logs, snap()));
    applyBatch(fixAzureSlotWarmup(logs, snap()));
    applyBatch(fixBlueGreenConfigSync(logs, snap()));
    applyBatch(fixBlueGreenTTL(logs, snap()));
    applyBatch(fixConnectionDraining(logs, snap()));
  }

  if (hasCategory('canary_mismatch')) {
    applyBatch(fixCanaryDeployment(logs, snap()));
    applyBatch(fixCanaryIngressAnnotation(logs, snap()));
    categoryRule(fixCanaryK8sReplicaCount);
    applyBatch(fixCanaryMetricAnalysis(logs, snap()));
    applyBatch(fixCanaryRollbackThreshold(logs, snap()));
    applyBatch(fixCanaryCloudRunRevision(logs, snap()));
    applyBatch(fixCanaryECSTaskWeight(logs, snap()));
    applyBatch(fixCanaryProgressivePause(logs, snap()));
    applyBatch(fixCanaryFlaggerHPA(logs, snap()));
    applyBatch(fixCanaryHeaderRouting(logs, snap()));
  }

  if (hasCategory('health_check_failure')) {
    applyBatch(fixDockerHealthcheck(logs, snap()));
    applyBatch(fixBlueGreenHealthCheck(logs, snap()));
    applyBatch(fixHealthCheckEndpointPath(logs, snap()));
    applyBatch(fixHealthCheckInterval(logs, snap()));
    applyBatch(fixHealthCheckDependencies(logs, snap()));
    applyBatch(fixHealthCheckHTTPS(logs, snap()));
    applyBatch(fixHealthCheckPort(logs, snap()));
    applyBatch(fixLivenessReadinessProbes(logs, snap()));
    applyBatch(fixStartupProbeTimeout(logs, snap()));
    applyBatch(fixHealthCheckResponseCode(logs, snap()));
    categoryRule(fixDockerStartupHealthcheck);
  }

  if (hasCategory('load_balancer_issue')) {
    applyBatch(fixLoadBalancerRouting(logs, snap()));
    applyBatch(fixServiceUnavailable(logs, snap()));
    applyBatch(fixALBTargetGroupHealthCheck(logs, snap()));
    applyBatch(fixNGINXProxyReadTimeout(logs, snap()));
    applyBatch(fixNLBPreserveClientIP(logs, snap()));
    applyBatch(fixCORSHeadersLB(logs, snap()));
    applyBatch(fixHTTPSRedirectLB(logs, snap()));
    applyBatch(fixLBStickySessions(logs, snap()));
    applyBatch(fixLBDrainingTimeout(logs, snap()));
    applyBatch(fixTraefikRouteConfig(logs, snap()));
  }

  if (hasCategory('api_rate_limit')) {
    applyBatch(fixRateLimitBackoff(logs, snap()));
    applyBatch(fixAPIPagination(logs, snap()));
    applyBatch(fixDockerHubRateLimit(logs, snap()));
    applyBatch(fixBrokenThirdPartyIntegration(logs, snap()));
    applyBatch(fixGitHubAPIRateLimit(logs, snap()));
    applyBatch(fixRetryAfterHeader(logs, snap()));
    applyBatch(fixNpmPublishRateLimit(logs, snap()));
    applyBatch(fixAPIBulkBatching(logs, snap()));
    applyBatch(fixLeakyBucketSleep(logs, snap()));
    applyBatch(fixStripeRateLimit(logs, snap()));
    applyBatch(fixGitLabAPIThrottle(logs, snap()));
    applyBatch(fixSendGridRateLimit(logs, snap()));
    applyBatch(fixDockerHubAnonymousPullLimit(logs, snap()));
  }

  if (hasCategory('api_timeout')) {
    applyBatch(fixAPIRetryOnTimeout(logs, snap()));
    applyBatch(fixSSLCertVerification(logs, snap()));
    applyBatch(fixInvalidAPIResponse(logs, snap()));
    applyBatch(fixAPIConnectTimeout(logs, snap()));
    applyBatch(fixAxiosTimeout(logs, snap()));
    applyBatch(fixFetchAbortController(logs, snap()));
    applyBatch(fixServiceMeshTimeout(logs, snap()));
    applyBatch(fixGRPCDeadline(logs, snap()));
    applyBatch(fixGraphQLRequestTimeout(logs, snap()));
    applyBatch(fixAPIGatewayIntegrationTimeout(logs, snap()));
    applyBatch(fixCurlRetryFlags(logs, snap()));
    applyBatch(fixJobAPICallTimeout(logs, snap()));
  }

  if (hasCategory('webhook_failure')) {
    applyBatch(fixWebhookSecret(logs, snap()));
    applyBatch(fixSchemaValidationFailure(logs, snap()));
    applyBatch(fixGraphQLQueryFailure(logs, snap()));
    applyBatch(fixWebhookHMACVerification(logs, snap()));
    applyBatch(fixWebhookReplayProtection(logs, snap()));
    applyBatch(fixWebhookIdempotencyKey(logs, snap()));
    applyBatch(fixWebhookTimeoutResponse(logs, snap()));
    applyBatch(fixWebhookPayloadSize(logs, snap()));
    applyBatch(fixWebhookIPAllowlist(logs, snap()));
    applyBatch(fixWebhookTLSValidation(logs, snap()));
    applyBatch(fixGitHubWebhookEvents(logs, snap()));
  }

  if (hasCategory('yaml_syntax')) {
    categoryRule(fixYamlTabIndentation);
    categoryRule(fixDuplicateYamlKey);
    applyBatch(fixMissingYamlColon(logs, snap()));
    categoryRule(fixStepUsesAndRun);
    categoryRule(fixMissingWorkflowTrigger);
    categoryRule(fixWorkflowTriggerTypo);
    categoryRule(fixIncorrectConfigHierarchy);
    applyBatch(fixUnsupportedConfigParameter(logs, snap()));
    applyBatch(fixGitLabYamlAnchors(logs, snap()));
    categoryRule(fixDuplicateGitLabStage);
    applyBatch(fixDuplicateJobId(logs, snap()));
    categoryRule(fixDuplicateEnvKey);
  }

  if (hasCategory('invalid_gitlab_ci')) {
    applyBatch(fixGitLabYamlAnchors(logs, snap()));
    applyBatch(fixGitLabJobMissingImage(logs, snap()));
    applyBatch(fixGitLabExtendsMissing(logs, snap()));
    categoryRule(fixGitLabRulesNeverMatch);
    categoryRule(fixGitLabWorkflowRules);
    applyBatch(fixGitLabTriggerConfig(logs, snap()));
    applyBatch(fixGitLabParallelMatrix(logs, snap()));
    applyBatch(fixGitLabServicesConfig(logs, snap()));
    categoryRule(fixGitLabEnvironmentConfig);
    categoryRule(fixGitLabResourceGroup);
    categoryRule(fixGitLabStageOrder);
    categoryRule(fixGitLabStageOrdering);
    categoryRule(fixDuplicateGitLabStage);
    applyBatch(fixGitLabBeforeScriptLevel(logs, snap()));
    applyBatch(fixGitLabCECompatibility(logs, snap()));
    categoryRule(fixGitLabVariableScope);
    categoryRule(fixGitLabIncludePath);
  }

  if (hasCategory('invalid_workflow_syntax')) {
    applyBatch(fixInvalidJobId(logs, snap()));
    applyBatch(fixWorkflowExpressionSyntax(logs, snap()));
    categoryRule(fixWorkflowIfCondition);
    applyBatch(fixMissingStepsKey(logs, snap()));
    categoryRule(fixReusableWorkflowPin);
    categoryRule(fixMissingWorkflowName);
    applyBatch(fixActionInputTypeMismatch(logs, snap()));
    categoryRule(fixIfAlwaysSyntax);
    categoryRule(fixStepUsesAndRunConflict);
    applyBatch(fixDuplicateJobId(logs, snap()));
    categoryRule(fixDuplicatePermissions);
    categoryRule(fixIncorrectConfigHierarchy);
  }

  if (hasCategory('missing_config_file')) {
    applyBatch(fixMissingTsConfig(logs, snap()));
    applyBatch(fixConfigMissingTsConfig(logs, snap()));
    applyBatch(fixMissingViteConfig(logs, snap()));
    applyBatch(fixMissingVitestConfig(logs, snap()));
    applyBatch(fixTestingMissingVitestConfig(logs, snap()));
    applyBatch(fixMissingNvmrc(logs, snap()));
    applyBatch(fixMissingPyprojectToml(logs, snap()));
    categoryRule(fixMissingDockerignore);
    categoryRule(fixDockerMissingDockerignore);
    applyBatch(fixMissingGitignore(logs, snap()));
    applyBatch(fixMissingPostcssConfig(logs, snap()));
    applyBatch(fixMissingBabelConfig(logs, snap()));
    applyBatch(fixMissingEslintConfig(logs, snap()));
    applyBatch(fixMissingJestConfig(logs, snap()));
    applyBatch(fixMissingPrettierConfig(logs, snap()));
    categoryRule(fixGitLabIncludePath);
  }

  if (hasCategory('config_hierarchy_error')) {
    categoryRule(fixIncorrectConfigHierarchy);
    applyBatch(fixTsConfigExtendsChain(logs, snap()));
    applyBatch(fixGitLabBeforeScriptLevel(logs, snap()));
    applyBatch(fixPackageJsonWorkspacesLevel(logs, snap()));
    categoryRule(fixStepUsesAndRunConflict);
  }

  if (hasCategory('unsupported_config_param')) {
    applyBatch(fixUnsupportedConfigParameter(logs, snap()));
    applyBatch(fixDeprecatedTsConfigOptions(logs, snap()));
    categoryRule(fixDockerComposeVersionField);
    categoryRule(fixIfAlwaysSyntax);
    applyBatch(fixGitLabCECompatibility(logs, snap()));
    applyBatch(fixNpmEnginesRange(logs, snap()));
  }

  if (hasCategory('duplicate_config_key')) {
    applyBatch(fixDuplicateJobId(logs, snap()));
    categoryRule(fixDuplicateGitLabStage);
    categoryRule(fixDuplicateEnvKey);
    categoryRule(fixDuplicateDockerPort);
    categoryRule(fixDuplicatePermissions);
    categoryRule(fixDuplicatePackageScript);
    categoryRule(fixDuplicateYamlKey);
  }

  if (hasCategory('env_mapping_error')) {
    categoryRule(fixEnvContextScope);
    categoryRule(fixGitLabVariableScope);
    categoryRule(fixSecretToEnvMapping);
    categoryRule(fixInputToEnvMapping);
    categoryRule(fixJobOutputDeclaration);
    applyBatch(fixTerraformVarEnv(logs, snap()));
    applyBatch(fixDotenvLoadOrder(logs, snap()));
    applyBatch(fixDockerComposeEnvFile(logs, snap()));
    applyBatch(fixK8sSecretEnvMapping(logs, snap()));
    categoryRule(fixMissingSecretsContext);
    applyBatch(fixMissingAwsRegionMapping(logs, snap()));
  }

  if (hasCategory('db_migration_error')) {
    applyBatch(fixWaitForDatabase(logs, snap()));
    applyBatch(fixMigrationLockTimeout(logs, snap()));
    applyBatch(fixPrismaShadowDb(logs, snap()));
    applyBatch(fixMissingDBService(logs, snap()));
    applyBatch(fixMissingDatabaseURL(logs, snap()));
    applyBatch(fixQueryExecutionFailure(logs, snap()));
    applyBatch(fixReplicationLag(logs, snap()));
    applyBatch(fixFlywayCIConfig(logs, snap()));
    applyBatch(fixLiquibaseChangelog(logs, snap()));
    applyBatch(fixPrismaMigrateDeploy(logs, snap()));
    applyBatch(fixAlembicRevisionCheck(logs, snap()));
    applyBatch(fixRailsMigrationIdempotent(logs, snap()));
    applyBatch(fixKnexMigrationSource(logs, snap()));
    applyBatch(fixSequelizeMigrationState(logs, snap()));
    applyBatch(fixGooseMigrationVersion(logs, snap()));
    applyBatch(fixMigrationRollbackStep(logs, snap()));
    applyBatch(fixMigrationBaselineExisting(logs, snap()));
    applyBatch(fixGitLabDBService(logs, snap()));
    applyBatch(fixGitLabDatabaseURL(logs, snap()));
    applyBatch(fixGitLabPrismaShadowDb(logs, snap()));
    applyBatch(fixGitLabAlembicRevisionCheck(logs, snap()));
    applyBatch(fixGitLabGooseMigrationVersion(logs, snap()));
    applyBatch(fixGitLabMigrationRollback(logs, snap()));
  }

  if (hasCategory('db_connection_error')) {
    applyBatch(fixWaitForDatabase(logs, snap()));
    applyBatch(fixMissingDBService(logs, snap()));
    applyBatch(fixMissingDatabaseURL(logs, snap()));
    applyBatch(fixMissingMySQLService(logs, snap()));
    applyBatch(fixMissingRedisService(logs, snap()));
    applyBatch(fixQueryExecutionFailure(logs, snap()));
    applyBatch(fixReplicationLag(logs, snap()));
    applyBatch(fixPGConnectionPool(logs, snap()));
    applyBatch(fixMySQLConnectionPool(logs, snap()));
    applyBatch(fixMongoConnectionTimeout(logs, snap()));
    applyBatch(fixRedisConnectionRetry(logs, snap()));
    applyBatch(fixDBConnectionSSL(logs, snap()));
    applyBatch(fixDBConnectionKeepalive(logs, snap()));
    applyBatch(fixDBConnectionEnvValidation(logs, snap()));
    applyBatch(fixDBConnectionProxyTimeout(logs, snap()));
    applyBatch(fixDBNetworkPolicyCIJob(logs, snap()));
    applyBatch(fixGitLabDBService(logs, snap()));
    applyBatch(fixGitLabMySQLService(logs, snap()));
    applyBatch(fixGitLabRedisService(logs, snap()));
    applyBatch(fixGitLabDatabaseURL(logs, snap()));
    applyBatch(fixGitLabDBConnectionValidation(logs, snap()));
    applyBatch(fixGitLabProxyConnectionWait(logs, snap()));
    applyBatch(fixGitLabNetworkPolicy(logs, snap()));
  }

  if (hasCategory('db_deadlock')) {
    applyBatch(fixMigrationLockTimeout(logs, snap()));
    applyBatch(fixMissingDatabaseIndex(logs, snap()));
    applyBatch(fixQueryExecutionFailure(logs, snap()));
    applyBatch(fixDeadlockRetryLogic(logs, snap()));
    applyBatch(fixDeadlockLockTimeout(logs, snap()));
    applyBatch(fixDeadlockIsolationLevel(logs, snap()));
    applyBatch(fixDeadlockRowLevelLocking(logs, snap()));
    applyBatch(fixDeadlockMonitoring(logs, snap()));
    applyBatch(fixDeadlockCISerialRun(logs, snap()));
    applyBatch(fixDeadlockIndexForUpdate(logs, snap()));
    applyBatch(fixDeadlockConcurrencyGroup(logs, snap()));
    applyBatch(fixGitLabDeadlockMonitoring(logs, snap()));
    applyBatch(fixGitLabDbResourceGroup(logs, snap()));
  }

  if (hasCategory('db_schema_mismatch')) {
    applyBatch(fixSchemaDriftDetection(logs, snap()));
    applyBatch(fixPrismaSchemaSync(logs, snap()));
    applyBatch(fixTypeORMSchemaDrop(logs, snap()));
    applyBatch(fixDjangoMakeMigrationsCheck(logs, snap()));
    applyBatch(fixRailsSchemaLoad(logs, snap()));
    applyBatch(fixFlywaySchemaDiff(logs, snap()));
    applyBatch(fixLiquibaseValidate(logs, snap()));
    applyBatch(fixSchemaVersionTable(logs, snap()));
    applyBatch(fixSchemaBackwardCompat(logs, snap()));
    applyBatch(fixGitLabSchemaDriftDetection(logs, snap()));
    applyBatch(fixGitLabPrismaSchemaSync(logs, snap()));
    applyBatch(fixGitLabDjangoMigrationsCheck(logs, snap()));
    applyBatch(fixGitLabSchemaVersionTable(logs, snap()));
  }

  if (hasCategory('missing_db_index')) {
    applyBatch(fixMissingDatabaseIndex(logs, snap()));
    applyBatch(fixCompositeIndexCreation(logs, snap()));
    applyBatch(fixPartialIndexCreation(logs, snap()));
    applyBatch(fixGINIndexForJSONB(logs, snap()));
    applyBatch(fixForeignKeyIndex(logs, snap()));
    applyBatch(fixUniqueIndexConstraint(logs, snap()));
    applyBatch(fixIndexStatisticsUpdate(logs, snap()));
    applyBatch(fixIndexBloatReindex(logs, snap()));
    applyBatch(fixQueryPlannerHint(logs, snap()));
    applyBatch(fixGitLabMissingDatabaseIndex(logs, snap()));
    applyBatch(fixGitLabIndexStatistics(logs, snap()));
    applyBatch(fixGitLabIndexBloatCheck(logs, snap()));
  }

  if (hasCategory('transaction_rollback')) {
    applyBatch(fixTransactionSavepoint(logs, snap()));
    applyBatch(fixTransactionIsolationLevel(logs, snap()));
    applyBatch(fixTransactionTimeout(logs, snap()));
    applyBatch(fixTransactionDeadlockRetry(logs, snap()));
    applyBatch(fixTransactionConnectionReturn(logs, snap()));
    applyBatch(fixNestedTransactionPrisma(logs, snap()));
    applyBatch(fixTransactionRollbackLogging(logs, snap()));
    applyBatch(fixAtomicMigrationTransaction(logs, snap()));
  }

  // ── New granular category dispatches ─────────────────────────────────────
  if (hasCategory('db_query_failure')) {
    applyBatch(fixQueryExecutionFailure(logs, snap()));
    applyBatch(fixWaitForDatabase(logs, snap()));
    applyBatch(fixMissingDBService(logs, snap()));
    applyBatch(fixSlowQueryTimeout(logs, snap()));
    applyBatch(fixNPlusOneQueryDetect(logs, snap()));
    applyBatch(fixQueryAnalyzeExplain(logs, snap()));
    applyBatch(fixDBQueryLogging(logs, snap()));
    applyBatch(fixQueryMemoryLimit(logs, snap()));
    applyBatch(fixQueryResultPagination(logs, snap()));
    applyBatch(fixQueryTransactionWrapper(logs, snap()));
    applyBatch(fixQueryStatStatements(logs, snap()));
    applyBatch(fixGitLabQueryExplainOnFail(logs, snap()));
    applyBatch(fixGitLabQueryStatStatements(logs, snap()));
  }

  if (hasCategory('db_replication_lag')) {
    applyBatch(fixReplicationLag(logs, snap()));
    applyBatch(fixReadWriteSplit(logs, snap()));
    applyBatch(fixReplicationSlotMonitor(logs, snap()));
    applyBatch(fixSynchronousCommit(logs, snap()));
    applyBatch(fixReplicaHealthCheck(logs, snap()));
    applyBatch(fixLogicalReplicationSetup(logs, snap()));
    applyBatch(fixReplicationMonitoringStep(logs, snap()));
    applyBatch(fixCDCEventStreamLag(logs, snap()));
    applyBatch(fixReplicationFailoverConfig(logs, snap()));
    applyBatch(fixGitLabReplicationSlotMonitor(logs, snap()));
    applyBatch(fixGitLabReplicaHealthCheck(logs, snap()));
    applyBatch(fixGitLabReplicationLagWait(logs, snap()));
    applyBatch(fixGitLabCDCLagCheck(logs, snap()));
  }

  if (hasCategory('lockfile_corrupt')) {
    applyBatch(fixCorruptedLockfile(logs, snap()));
    categoryRule(fixNpmCiToInstall);
  }

  if (hasCategory('venv_missing')) {
    applyBatch(fixMissingVirtualEnv(logs, snap()));
    categoryRule(fixPipNoCacheDir);
    applyBatch(fixPipUpgrade(logs, snap()));
    applyBatch(fixPythonPath(logs, snap()));
  }

  if (hasCategory('invalid_branch')) {
    applyBatch(fixInvalidBranchReference(logs, snap()));
    applyBatch(fixShallowClone(logs, snap()));
  }

  if (hasCategory('circular_dependency')) {
    applyBatch(fixCircularDependency(logs, snap()));
  }

  if (hasCategory('port_conflict')) {
    applyBatch(fixPortBindingConflict(logs, snap()));
    applyBatch(fixDockerRandomPortAssignment(logs, snap()));
    applyBatch(fixDockerNetworkSubnetConflict(logs, snap()));
    applyBatch(fixDockerIPv6BindingConflict(logs, snap()));
    categoryRule(fixDockerComposePortFormat);
    categoryRule(fixDockerServiceContainerPorts);
  }

  if (hasCategory('image_pull_failure')) {
    applyBatch(fixDockerImagePullFailure(logs, snap()));
    applyBatch(fixDockerHubRateLimit(logs, snap()));
    categoryRule(fixDockerBaseImagePin);
    categoryRule(fixDockerImageDigestPin);
    applyBatch(fixDockerRegistryPathFormat(logs, snap()));
    applyBatch(fixDockerTagFallback(logs, snap()));
    applyBatch(fixDockerComposePrivateImageAuth(logs, snap()));
    applyBatch(fixDockerAlpineApkMirror(logs, snap()));
    applyBatch(fixDockerPullPlatformMismatch(logs, snap()));
  }

  if (hasCategory('service_unavailable')) {
    applyBatch(fixServiceUnavailable(logs, snap()));
    applyBatch(fixConnectionDraining(logs, snap()));
    applyBatch(fixServiceStartupProbe(logs, snap()));
    categoryRule(fixServicePodDisruptionBudget);
    categoryRule(fixServiceHPAMinReplicas);
    applyBatch(fixServiceGracefulShutdown(logs, snap()));
    categoryRule(fixServiceTopologySpread);
    applyBatch(fixServiceCircuitBreaker(logs, snap()));
    categoryRule(fixServiceReadinessGate);
    applyBatch(fixServiceResourceQuota(logs, snap()));
  }

  if (hasCategory('invalid_api_response')) {
    applyBatch(fixInvalidAPIResponse(logs, snap()));
    applyBatch(fixAPIVersionHeader(logs, snap()));
    applyBatch(fixAPIRetryOnTimeout(logs, snap()));
    applyBatch(fixAPIResponseJSONParse(logs, snap()));
    applyBatch(fixAPIEmptyResponseGuard(logs, snap()));
    applyBatch(fixRedirectHandling(logs, snap()));
    applyBatch(fixAPIStatusCodeRange(logs, snap()));
    applyBatch(fixAPIContentTypeCheck(logs, snap()));
    applyBatch(fixAPIResponseCaching(logs, snap()));
    applyBatch(fixAPIEnvelopeUnwrap(logs, snap()));
    applyBatch(fixAPIErrorBodyParsing(logs, snap()));
  }

  if (hasCategory('third_party_failure')) {
    applyBatch(fixBrokenThirdPartyIntegration(logs, snap()));
    categoryRule(fixSlackNotificationSecret);
    applyBatch(fixSentryDSNEnvVar(logs, snap()));
    applyBatch(fixDatadogAgentConfig(logs, snap()));
    applyBatch(fixSonarCloudQualityGate(logs, snap()));
    applyBatch(fixCodecovTokenMissing(logs, snap()));
    applyBatch(fixSnykAuthToken(logs, snap()));
    applyBatch(fixPagerdutyIntegration(logs, snap()));
    applyBatch(fixJiraIntegrationConfig(logs, snap()));
    applyBatch(fixNewRelicLicenseKey(logs, snap()));
  }

  if (hasCategory('schema_validation')) {
    applyBatch(fixSchemaValidationFailure(logs, snap()));
    applyBatch(fixGraphQLQueryFailure(logs, snap()));
    applyBatch(fixOpenAPISpectralLint(logs, snap()));
    applyBatch(fixJSONSchemaVersion(logs, snap()));
    applyBatch(fixAJVStrictMode(logs, snap()));
    applyBatch(fixProtobufSchemaBreaking(logs, snap()));
    applyBatch(fixOpenAPIRequestValidator(logs, snap()));
    applyBatch(fixSchemaRegistryCompat(logs, snap()));
    applyBatch(fixGraphQLSchemaLint(logs, snap()));
    applyBatch(fixZodSchemaValidation(logs, snap()));
  }

  if (hasCategory('graphql_failure')) {
    applyBatch(fixGraphQLQueryFailure(logs, snap()));
    applyBatch(fixAPIVersionHeader(logs, snap()));
    applyBatch(fixGraphQLIntrospectionQuery(logs, snap()));
    applyBatch(fixGraphQLFragmentDefinition(logs, snap()));
    applyBatch(fixGraphQLNullableFields(logs, snap()));
    applyBatch(fixGraphQLPersistQuery(logs, snap()));
    applyBatch(fixGraphQLDeprecatedField(logs, snap()));
    applyBatch(fixGraphQLCORSHeaders(logs, snap()));
    applyBatch(fixGraphQLBatchRequest(logs, snap()));
  }

  if (hasCategory('rest_endpoint_mismatch')) {
    categoryRule(fixRESTBaseURLEnvVar);
    applyBatch(fixRESTVersionPrefix(logs, snap()));
    applyBatch(fixRESTMethodMismatch(logs, snap()));
    applyBatch(fixRESTTrailingSlash(logs, snap()));
    applyBatch(fixRESTAuthHeader(logs, snap()));
    applyBatch(fixRESTContentTypeHeader(logs, snap()));
    categoryRule(fixRESTEndpointEnvMatrix);
    applyBatch(fixRESTIdempotencyHeader(logs, snap()));
    applyBatch(fixRESTResponseTimeLogging(logs, snap()));
  }

  // ── NEW categories ────────────────────────────────────────────────────────

  if (hasCategory('husky_hook_failure')) {
    categoryRule(fixHuskyCI);
    categoryRule(fixHuskyPreCommitCI);
  }

  if (hasCategory('go_build_failure')) {
    categoryRule(fixGoModDownload);
    applyBatch(fixGitConfigSafeDirectory(logs, snap()));
  }

  if (hasCategory('rust_build_failure')) {
    categoryRule(fixRustCargoCache);
    applyBatch(fixRustCompilationError(logs, snap()));
    categoryRule(fixRustToolchainFile);
    categoryRule(fixCargoWorkspaceBuild);
    categoryRule(fixRustBinaryArtifact);
  }

  if (hasCategory('e2e_failure')) {
    categoryRule(fixPlaywrightBrowserInstall);
    categoryRule(fixCypressCIDependencies);
    applyBatch(fixTestEnvironmentMisconfig(logs, snap()));
    applyBatch(fixIntegrationTestFailure(logs, snap()));
  }

  if (hasCategory('lint_format_failure')) {
    applyBatch(fixMissingPrettierConfig(logs, snap()));
    applyBatch(fixESLintFlatConfig(logs, snap()));
    applyBatch(fixMissingEslintConfig(logs, snap()));
  }

  if (hasCategory('git_tag_failure')) {
    applyBatch(fixMissingGitTags(logs, snap()));
    applyBatch(fixGitTagSigning(logs, snap()));
    applyBatch(fixShallowClone(logs, snap()));
  }

  if (hasCategory('git_credential_failure')) {
    applyBatch(fixGitCredentialHelper(logs, snap()));
    applyBatch(fixGitHubActionsToken(logs, snap()));
    applyBatch(fixGitLabTokenPushAuth(logs, snap()));
  }

  if (hasCategory('oidc_failure') || hasCategory('aws_auth_failure') || hasCategory('gcp_auth_failure')) {
    applyBatch(fixAdvancedOidc(logs, snap()));
    applyBatch(fixOidcPermission(logs, snap()));
    applyBatch(fixMissingPermissions(logs, snap()));
  }

  if (hasCategory('secret_missing')) {
    applyBatch(fixOptionalSecretSteps(logs, snap()));
    applyBatch(fixAddDebugFlags(logs, snap()));
  }

  if (hasCategory('terraform_failure')) {
    categoryRule(fixTerraformEnvVars);
    applyBatch(fixMissingPermissions(logs, snap()));
  }

  if (hasCategory('matrix_failure')) {
    categoryRule(fixFailFastMatrix);
    categoryRule(fixParallelJobTimeouts);
    applyBatch(fixMissingRunner(logs, snap()));
  }

  if (hasCategory('artifact_retention')) {
    categoryRule(fixArtifactRetentionDays);
    applyBatch(fixArtifactNameMismatch(logs, snap()));
  }

  if (hasCategory('vite_build_failure')) {
    categoryRule(fixViteProductionBuild);
    applyBatch(fixNodeHeapMemory(logs, snap()));
    applyBatch(fixESBuildPathResolution(logs, snap()));
    applyBatch(fixESMCJSConflict(logs, snap()));
    applyBatch(fixTypeScriptPathAlias(logs, snap()));
    applyBatch(fixNodeExperimentalFlags(logs, snap()));
  }

  if (hasCategory('webpack_build_failure')) {
    applyBatch(fixWebpackMemoryLimit(logs, snap()));
    applyBatch(fixNodeHeapOOM(logs, snap()));
    applyBatch(fixBabelPresetConfig(logs, snap()));
    applyBatch(fixSassMigration(logs, snap()));
    applyBatch(fixESMCJSConflict(logs, snap()));
  }

  if (hasCategory('dotnet_build_failure')) {
    categoryRule(fixDotnetRestore);
    applyBatch(fixDotNetCompilationError(logs, snap()));
    applyBatch(fixDotNetTargetFramework(logs, snap()));
    categoryRule(fixDotNetPublishArtifact);
  }

  // ════════════════════════════════════════════════════════════════════════
  // CROSS-CATEGORY log-gated rules — fire for ANY category if log pattern matches
  // ════════════════════════════════════════════════════════════════════════

  // Simple cross-category
  applyBatch(fixScriptTypo(logs, snap()));
  applyBatch(fixWindowsCommandsOnLinux(logs, snap()));
  applyBatch(fixIncorrectFilePath(logs, snap()));
  applyBatch(fixInvalidJsonSyntax(logs, snap()));
  applyBatch(fixIncorrectVariableName(logs, snap()));
  applyBatch(fixCorruptedLockfile(logs, snap()));
  applyBatch(fixYarnLockfileCorruption(logs, snap()));
  applyBatch(fixPoetryLockfileCorruption(logs, snap()));
  applyBatch(fixGemfileLockCorruption(logs, snap()));
  applyBatch(fixPnpmLockfileCorruption(logs, snap()));
  applyBatch(fixMissingVirtualEnv(logs, snap()));
  applyBatch(fixPoetryVirtualEnv(logs, snap()));
  applyBatch(fixUnsupportedEngineVersion(logs, snap()));
  applyBatch(fixPythonVersionPin(logs, snap()));
  applyBatch(fixJavaVersionPin(logs, snap()));
  applyBatch(fixGoVersionPin(logs, snap()));
  applyBatch(fixRubyVersionPin(logs, snap()));
  applyBatch(fixPeerDepConflict(logs, snap()));
  applyBatch(fixNpmOverrides(logs, snap()));
  applyBatch(fixYarnResolutions(logs, snap()));
  applyBatch(fixPipDependencyConflict(logs, snap()));
  applyBatch(fixPipIgnoreRequiresPython(logs, snap()));
  applyBatch(fixMavenDependencyConflict(logs, snap()));
  applyBatch(fixDeprecatedNpmDependency(logs, snap()));
  applyBatch(fixCompilationFailure(logs, snap()));
  applyBatch(fixInvalidBuildTarget(logs, snap()));
  staticRule(fixDockerBuildArgEnvVars);
  staticRule(fixGoModDownload);
  staticRule(fixRustCargoCache);
  applyBatch(fixESBuildPathResolution(logs, snap()));
  staticRule(fixMakefileCIMode);

  // Intermediate cross-category
  applyBatch(fixShallowCloneFetchDepth(logs, snap()));
  applyBatch(fixGitShallowCloneFetchDepth(logs, snap()));
  applyBatch(fixInvalidBranchReference(logs, snap()));
  applyBatch(fixRejectedCommit(logs, snap()));
  applyBatch(fixCircularDependency(logs, snap()));
  applyBatch(fixMissingRunner(logs, snap()));
  applyBatch(fixFailedPipelineStageRetry(logs, snap()));
  applyBatch(fixActionsVersionUpgrade(logs, snap()));
  applyBatch(fixUnsupportedConfigParameter(logs, snap()));
  applyBatch(fixMissingPermissions(logs, snap()));
  applyBatch(fixAdvancedOidc(logs, snap()));
  applyBatch(fixJobTimeout(logs, snap()));
  applyBatch(fixConfigJobTimeout(logs, snap()));
  staticRule(fixMissingConcurrencyGroup);
  applyBatch(fixNullReferenceException(logs, ciSnap()));
  applyBatch(fixTypeMismatch(logs, snap()));
  applyBatch(fixNodeHeapOOM(logs, snap()));
  applyBatch(fixUnhandledRejection(logs, ciSnap()));
  applyBatch(fixUnitTestFailure(logs, snap()));
  applyBatch(fixIntegrationTestFailure(logs, snap()));
  applyBatch(fixTestEnvironmentMisconfig(logs, snap()));
  applyBatch(fixSubmoduleCheckout(logs, snap()));
  applyBatch(fixGitLFSCheckout(logs, snap()));
  applyBatch(fixGitUserConfig(logs, snap()));
  applyBatch(fixSSHKnownHosts(logs, snap()));
  applyBatch(fixAdvancedSSHKnownHosts(logs, snap()));
  applyBatch(fixTestTimeout(logs, snap()));
  applyBatch(fixMissingJestConfig(logs, snap()));
  // Testing cross-category — extended
  applyBatch(fixJestRunInBand(logs, snap()));
  applyBatch(fixJestForceExit(logs, snap()));
  applyBatch(fixFlakyTestRetry(logs, snap()));
  applyBatch(fixVitestRetry(logs, snap()));
  applyBatch(fixPytestRerunFails(logs, snap()));
  applyBatch(fixGoTestTimeout(logs, snap()));
  applyBatch(fixRustTestSerial(logs, snap()));
  applyBatch(fixDotNetTestLogger(logs, snap()));
  applyBatch(fixJestWorkerCount(logs, snap()));
  applyBatch(fixDockerComposeTestUp(logs, snap()));
  applyBatch(fixTestContainersPull(logs, snap()));
  applyBatch(fixDatabaseMigrationBeforeTest(logs, snap()));
  applyBatch(fixKafkaServiceIntegration(logs, snap()));
  applyBatch(fixMinioServiceIntegration(logs, snap()));
  applyBatch(fixGRPCServiceHealth(logs, snap()));
  applyBatch(fixIntegrationTestRetry(logs, snap()));
  applyBatch(fixTestDatabaseIsolation(logs, snap()));
  applyBatch(fixWaitForServiceReady(logs, snap()));
  applyBatch(fixJestUpdateSnapshot(logs, snap()));
  applyBatch(fixSnapshotSerializer(logs, snap()));
  applyBatch(fixSnapshotDiffArtifact(logs, snap()));
  applyBatch(fixObsoleteSnapshots(logs, snap()));
  applyBatch(fixEsmMockSupport(logs, snap()));
  applyBatch(fixMockModuleReset(logs, snap()));
  applyBatch(fixMockTimers(logs, snap()));
  applyBatch(fixModuleNameMapper(logs, snap()));
  applyBatch(fixPythonMockPatch(logs, snap()));
  applyBatch(fixNockHttpMocking(logs, snap()));
  applyBatch(fixVitestMockHoisting(logs, snap()));
  applyBatch(fixMockEnvVarSetup(logs, snap()));
  applyBatch(fixMSWSetup(logs, snap()));
  applyBatch(fixJestSetupFiles(logs, snap()));
  applyBatch(fixVitestSetupFiles(logs, snap()));
  applyBatch(fixJestTransformIgnore(logs, snap()));
  applyBatch(fixJestModuleExtensions(logs, snap()));
  applyBatch(fixPytestConftestSetup(logs, snap()));
  applyBatch(fixCypressConfig(logs, snap()));
  applyBatch(fixVitestAliasConfig(logs, snap()));
  applyBatch(fixCoverageJSONReporter(logs, snap()));
  applyBatch(fixVitestCoverageProvider(logs, snap()));
  applyBatch(fixCodecovUploadStep(logs, snap()));
  applyBatch(fixCoverageCollectAllFiles(logs, snap()));
  applyBatch(fixCoverageExcludeGenerated(logs, snap()));
  applyBatch(fixPerFileCoverageThreshold(logs, snap()));
  applyBatch(fixPytestCoverageConfig(logs, snap()));
  applyBatch(fixGitLabCoverageRegex(logs, snap()));
  // NEW cross-category — git
  applyBatch(fixGitConfigSafeDirectory(logs, snap()));
  applyBatch(fixGitTagSigning(logs, snap()));
  applyBatch(fixGitCredentialHelper(logs, snap()));
  applyBatch(fixMissingGitTags(logs, snap()));
  applyBatch(fixShallowCloneFetchDepth(logs, snap()));
  applyBatch(fixGitShallowCloneFetchDepth(logs, snap()));
  applyBatch(fixAnnotatedTagForRelease(logs, snap()));
  applyBatch(fixFetchAllBranches(logs, snap()));
  applyBatch(fixGitGCDiskSpace(logs, snap()));
  applyBatch(fixGitCleanWorkingTree(logs, snap()));
  applyBatch(fixNonFastForwardPush(logs, snap()));
  applyBatch(fixMergeUnrelatedHistories(logs, snap()));
  applyBatch(fixGitRebasePullStrategy(logs, snap()));
  applyBatch(fixDivergentBranchConfig(logs, snap()));
  applyBatch(fixGitHubActionsDetachedHead(logs, snap()));
  applyBatch(fixVersionBumpDetachedHead(logs, snap()));
  applyBatch(fixDefaultBranchRename(logs, snap()));
  applyBatch(fixMissingUpstreamBranch(logs, snap()));
  applyBatch(fixSSHKnownHosts(logs, snap()));
  applyBatch(fixAdvancedSSHKnownHosts(logs, snap()));
  applyBatch(fixGitLabDeployKey(logs, snap()));
  applyBatch(fixGitLabSubmoduleStrategy(logs, snap()));
  applyBatch(fixSubmoduleUpdateInit(logs, snap()));
  applyBatch(fixNestedSubmoduleRecursive(logs, snap()));
  applyBatch(fixDisableSigningInCI(logs, snap()));
  applyBatch(fixCommitMessageLint(logs, snap()));
  applyBatch(fixPreReceiveSecretHook(logs, snap()));
  applyBatch(fixBinaryMergeDriver(logs, snap()));
  applyBatch(fixStashBeforePull(logs, snap()));
  applyBatch(fixCherryPickAbort(logs, snap()));
  applyBatch(fixSparseCheckout(logs, snap()));
  applyBatch(fixPackageRegistryAuth(logs, snap()));
  applyBatch(fixGitLabCrossProjectToken(logs, snap()));
  applyBatch(fixAdvancedGitLabCrossProjectToken(logs, snap()));
  staticRule(fixPlaywrightBrowserInstall);
  staticRule(fixCypressCIDependencies);
  applyBatch(fixMissingPrettierConfig(logs, snap()));
  applyBatch(fixESLintFlatConfig(logs, snap()));
  applyBatch(fixWebpackMemoryLimit(logs, snap()));
  staticRule(fixDotnetRestore);
  staticRule(fixViteProductionBuild);
  staticRule(fixRubyBundlerSetup);
  applyBatch(fixAddDebugFlags(logs, snap()));
  // Pipeline cross-category
  applyBatch(fixShellStrictMode(logs, snap()));
  applyBatch(fixFlakyStageContinueOnError(logs, snap()));
  staticRule(fixGitLabIncrementalPipeline);
  staticRule(fixWorkflowRunWait);
  staticRule(fixGitLabStageOrdering);
  staticRule(fixGitLabDAGPipeline);
  applyBatch(fixSelfReferentialNeeds(logs, snap()));
  applyBatch(fixTwoJobCircularChain(logs, snap()));
  staticRule(fixPushBranchFilter);
  applyBatch(fixCronScheduleExpression(logs, snap()));
  staticRule(fixWorkflowCallContract);
  applyBatch(fixRunnerGroupFallback(logs, snap()));
  applyBatch(fixLargerRunnerSpec(logs, snap()));
  applyBatch(fixStepLevelTimeout(logs, snap()));
  applyBatch(fixGitLabJobTimeout(logs, snap()));
  applyBatch(fixHangingProcessWatchdog(logs, snap()));
  applyBatch(fixArtifactUploadGlob(logs, snap()));
  applyBatch(fixMultipleArtifactUploads(logs, snap()));
  applyBatch(fixArtifactCompression(logs, snap()));
  applyBatch(fixCachePathMismatch(logs, snap()));
  applyBatch(fixCacheBust(logs, snap()));
  staticRule(fixDownloadAfterUpload);
  staticRule(fixParallelJobOutputPaths);
  staticRule(fixMatrixArtifactFanIn);
  staticRule(fixMatrixFanInSummary);
  // Config cross-category
  applyBatch(fixGitLabYamlAnchors(logs, snap()));
  applyBatch(fixGitLabJobMissingImage(logs, snap()));
  applyBatch(fixGitLabExtendsMissing(logs, snap()));
  applyBatch(fixGitLabServicesConfig(logs, snap()));
  applyBatch(fixGitLabTriggerConfig(logs, snap()));
  applyBatch(fixGitLabParallelMatrix(logs, snap()));
  applyBatch(fixInvalidJobId(logs, snap()));
  applyBatch(fixWorkflowExpressionSyntax(logs, snap()));
  applyBatch(fixActionInputTypeMismatch(logs, snap()));
  applyBatch(fixMissingStepsKey(logs, snap()));
  applyBatch(fixMissingTsConfig(logs, snap()));
  applyBatch(fixConfigMissingTsConfig(logs, snap()));
  applyBatch(fixMissingViteConfig(logs, snap()));
  applyBatch(fixMissingNvmrc(logs, snap()));
  applyBatch(fixMissingPyprojectToml(logs, snap()));
  applyBatch(fixMissingPostcssConfig(logs, snap()));
  applyBatch(fixMissingBabelConfig(logs, snap()));
  applyBatch(fixMissingGitignore(logs, snap()));
  applyBatch(fixTsConfigExtendsChain(logs, snap()));
  applyBatch(fixDeprecatedTsConfigOptions(logs, snap()));
  applyBatch(fixNpmEnginesRange(logs, snap()));
  staticRule(fixDuplicateDockerPort);
  staticRule(fixDuplicateGitLabStage);
  staticRule(fixDuplicatePackageScript);
  staticRule(fixInputToEnvMapping);
  staticRule(fixJobOutputDeclaration);
  applyBatch(fixTerraformVarEnv(logs, snap()));
  applyBatch(fixDockerComposeEnvFile(logs, snap()));
  applyBatch(fixK8sSecretEnvMapping(logs, snap()));
  applyBatch(fixMissingAwsRegionMapping(logs, snap()));
  applyBatch(fixGitLabCECompatibility(logs, snap()));
  staticRule(fixGitLabVariableScope);
  // Build fixers — cross-category
  applyBatch(fixGradleDaemonOOM(logs, snap()));
  staticRule(fixMavenBuildScript);
  applyBatch(fixTurboPipelineConfig(logs, snap()));
  applyBatch(fixShellScriptExitCodes(logs, snap()));
  applyBatch(fixJavaCompilationError(logs, snap()));
  applyBatch(fixGoCompilationError(logs, snap()));
  applyBatch(fixRustCompilationError(logs, snap()));
  applyBatch(fixDotNetCompilationError(logs, snap()));
  applyBatch(fixBabelPresetConfig(logs, snap()));
  applyBatch(fixSassMigration(logs, snap()));
  applyBatch(fixKotlinJvmTarget(logs, snap()));
  applyBatch(fixTypeScriptPathAlias(logs, snap()));
  applyBatch(fixESMCJSConflict(logs, snap()));
  applyBatch(fixGradleArtifactPath(logs, snap()));
  applyBatch(fixMavenArtifactPath(logs, snap()));
  staticRule(fixRustBinaryArtifact);
  staticRule(fixDotNetPublishArtifact);
  staticRule(fixGoArtifactPath);
  staticRule(fixNextExportArtifact);
  staticRule(fixDockerSaveArtifact);
  applyBatch(fixGradleTaskNotFound(logs, snap()));
  applyBatch(fixMavenGoalNotFound(logs, snap()));
  applyBatch(fixNpmWorkspaceScript(logs, snap()));
  applyBatch(fixTurboMissingTask(logs, snap()));
  applyBatch(fixBazelBuildTarget(logs, snap()));
  applyBatch(fixNodeExperimentalFlags(logs, snap()));
  staticRule(fixPython2to3);
  applyBatch(fixJavaReleaseFlag(logs, snap()));
  applyBatch(fixDotNetTargetFramework(logs, snap()));
  applyBatch(fixGoModDirective(logs, snap()));
  applyBatch(fixAndroidGradleBuild(logs, snap()));
  // Extended build fixers — cross-category
  staticRule(fixGraphQLCodegen);
  staticRule(fixProtobufGenerate);
  staticRule(fixCMakeBuildSetup);
  applyBatch(fixAngularBuildBudget(logs, snap()));
  applyBatch(fixPostCSSConfig(logs, snap()));
  staticRule(fixNuxtNitroPreset);
  staticRule(fixLambdaZipPackage);
  staticRule(fixNuGetPackageOutput);
  staticRule(fixHelmChartPackage);
  staticRule(fixElectronArtifactPath);
  staticRule(fixPythonWheelBuild);
  applyBatch(fixMixTask(logs, snap()));
  applyBatch(fixSbtBuildTask(logs, snap()));
  staticRule(fixDockerComposeBuildService);
  staticRule(fixOpenSSLLegacyProvider);
  applyBatch(fixRubyKeywordArgs(logs, snap()));
  applyBatch(fixPHPVersionCompat(logs, snap()));

  // Auth cross-category — fire on any log-pattern match regardless of detected category
  applyBatch(fixMissingBearerPrefix(logs, snap()));
  applyBatch(fixGitHubTokenScopes(logs, snap()));
  applyBatch(fixSAMLSSOTokenAuth(logs, snap()));
  applyBatch(fixWrongSecretReference(logs, snap()));
  applyBatch(fixAzureServicePrincipalAuth(logs, snap()));
  applyBatch(fixGCPWorkloadIdentityAuth(logs, snap()));
  applyBatch(fixAWSSTSAssumeRole(logs, snap()));
  applyBatch(fixGitHubAppInstallationToken(logs, snap()));
  applyBatch(fixAPIKeyQueryToHeader(logs, snap()));
  applyBatch(fixTokenValidationPreflight(logs, snap()));
  applyBatch(fixNPMTokenExpiry(logs, snap()));
  applyBatch(fixDockerHubTokenExpiry(logs, snap()));
  applyBatch(fixAWSCredentialOIDCUpgrade(logs, snap()));
  applyBatch(fixGCPSAKeyRefresh(logs, snap()));
  applyBatch(fixHerokuAPIKeyRotation(logs, snap()));
  applyBatch(fixAtlassianAPITokenExpiry(logs, snap()));
  applyBatch(fixTerraformCloudTokenRenewal(logs, snap()));
  applyBatch(fixContentsWritePermission(logs, snap()));
  applyBatch(fixPackagesWritePermission(logs, snap()));
  applyBatch(fixPackagesReadPermission(logs, snap()));
  applyBatch(fixPullRequestsWritePermission(logs, snap()));
  applyBatch(fixIssuesWritePermission(logs, snap()));
  applyBatch(fixChecksWritePermission(logs, snap()));
  applyBatch(fixPagesDeployPermission(logs, snap()));
  applyBatch(fixDeploymentsWritePermission(logs, snap()));
  applyBatch(fixSecurityEventsWritePermission(logs, snap()));
  applyBatch(fixActionsReadPermission(logs, snap()));
  applyBatch(fixWorkflowPermissionsBlock(logs, snap()));
  applyBatch(fixGitLabProtectedBranchPushGuard(logs, snap()));
  applyBatch(fixOAuthRedirectURIMismatch(logs, snap()));
  applyBatch(fixOAuthMissingScopes(logs, snap()));
  applyBatch(fixOAuthCSRFState(logs, snap()));
  applyBatch(fixGitHubOAuthAppConfig(logs, snap()));
  applyBatch(fixOAuthPKCEVerifier(logs, snap()));
  applyBatch(fixOAuthTokenStorage(logs, snap()));
  applyBatch(fixSSHKeyFormatEd25519(logs, snap()));
  applyBatch(fixSSHAgentSocketForwarding(logs, snap()));
  applyBatch(fixSSHDeployKeyWriteAccess(logs, snap()));
  applyBatch(fixSSHKeyPassphraseCI(logs, snap()));
  applyBatch(fixSSHHostKeyAlgorithmMismatch(logs, snap()));
  applyBatch(fixSSHMultipleHostsKeyscan(logs, snap()));
  applyBatch(fixSSHKeyFilePermissions600(logs, snap()));
  applyBatch(fixGitLabDeployKeyWriteAccess(logs, snap()));
  applyBatch(fixSSHJumpHostConfig(logs, snap()));
  applyBatch(fixEnvironmentSecretDeclaration(logs, snap()));
  applyBatch(fixForkPRSecretsUnavailable(logs, snap()));
  applyBatch(fixRequiredSecretPresenceCheck(logs, snap()));
  applyBatch(fixGitLabProtectedVariableAccess(logs, snap()));
  applyBatch(fixHashiCorpVaultTokenRenewal(logs, snap()));
  applyBatch(fixAWSIAMPermissionDiagnostic(logs, snap()));
  applyBatch(fixGCPIAMRoleBinding(logs, snap()));
  applyBatch(fixAzureRBACRoleAssignment(logs, snap()));
  applyBatch(fixKubernetesClusterRoleBinding(logs, snap()));
  applyBatch(fixTerraformStateBucketPermissions(logs, snap()));
  applyBatch(fixGitHubOIDCTrustPolicy(logs, snap()));
  applyBatch(fixECRRepositoryCrossAccountPolicy(logs, snap()));
  applyBatch(fixCloudRunServiceAccountInvoker(logs, snap()));
  applyBatch(fixCrossRepoCheckoutWithPAT(logs, snap()));
  applyBatch(fixGitLabGroupAccessToken(logs, snap()));
  applyBatch(fixPrivateSubmoduleTokenAuth(logs, snap()));
  applyBatch(fixGHCRCrossOrgPackageRead(logs, snap()));
  applyBatch(fixECRCrossAccountAccess(logs, snap()));
  applyBatch(fixGitLabCrossGroupCITrigger(logs, snap()));
  applyBatch(fixGoogleArtifactRegistryAuth(logs, snap()));
  applyBatch(fixAzureContainerRegistryAuth(logs, snap()));

  // Deployment cross-category — Section A (rollback)
  applyBatch(fixHelmRollbackOnFailure(logs, snap()));
  staticRule(fixKubectlRollbackAnnotation);
  staticRule(fixK8sRollbackHistoryLimit);
  applyBatch(fixHerokuReleaseRollback(logs, snap()));
  applyBatch(fixECSRollbackTaskDef(logs, snap()));
  applyBatch(fixCloudRunRollbackRevision(logs, snap()));
  applyBatch(fixTerraformDestroyGuard(logs, snap()));
  applyBatch(fixGitLabDeployRollback(logs, snap()));
  applyBatch(fixDeployRollbackNotification(logs, snap()));
  applyBatch(fixAzureSlotRollback(logs, snap()));
  applyBatch(fixFlyioRollback(logs, snap()));
  staticRule(fixArgoRollbackSyncWave);
  // Deployment cross-category — Section B (production deploy)
  staticRule(fixProdDeployGatingJob);
  staticRule(fixConcurrentDeployPrevention);
  applyBatch(fixPreDeploySmoke(logs, snap()));
  applyBatch(fixDeployEnvValidation(logs, snap()));
  applyBatch(fixTerraformPlanBeforeApply(logs, snap()));
  applyBatch(fixHelmDryRunFirst(logs, snap()));
  if (hardening) applyBatch(fixK8sApplyValidation(logs, snap())); // validation step, not a repair
  applyBatch(fixDeployTimeoutExtension(logs, snap()));
  staticRule(fixDockerImageHealthProbe);
  staticRule(fixProdDeployBranchGuard);
  staticRule(fixDeployTaggedRelease);
  // Deployment cross-category — Section C (blue-green)
  applyBatch(fixBlueGreenK8sService(logs, snap()));
  applyBatch(fixBlueGreenALBTargetGroup(logs, snap()));
  applyBatch(fixBlueGreenDatabaseMigration(logs, snap()));
  applyBatch(fixBlueGreenSmoke(logs, snap()));
  applyBatch(fixBlueGreenRollback(logs, snap()));
  applyBatch(fixBlueGreenSessionDrain(logs, snap()));
  applyBatch(fixAzureSlotWarmup(logs, snap()));
  applyBatch(fixBlueGreenConfigSync(logs, snap()));
  applyBatch(fixBlueGreenTTL(logs, snap()));
  // Deployment cross-category — Section D (canary)
  applyBatch(fixCanaryIngressAnnotation(logs, snap()));
  staticRule(fixCanaryK8sReplicaCount);
  applyBatch(fixCanaryMetricAnalysis(logs, snap()));
  applyBatch(fixCanaryRollbackThreshold(logs, snap()));
  applyBatch(fixCanaryCloudRunRevision(logs, snap()));
  applyBatch(fixCanaryECSTaskWeight(logs, snap()));
  applyBatch(fixCanaryProgressivePause(logs, snap()));
  applyBatch(fixCanaryFlaggerHPA(logs, snap()));
  applyBatch(fixCanaryHeaderRouting(logs, snap()));
  // Deployment cross-category — Section E (service availability)
  applyBatch(fixServiceStartupProbe(logs, snap()));
  staticRule(fixServicePodDisruptionBudget);
  staticRule(fixServiceHPAMinReplicas);
  applyBatch(fixServiceGracefulShutdown(logs, snap()));
  staticRule(fixServiceTopologySpread);
  applyBatch(fixServiceCircuitBreaker(logs, snap()));
  staticRule(fixServiceReadinessGate);
  applyBatch(fixServiceResourceQuota(logs, snap()));
  // Deployment cross-category — Section F (health checks)
  applyBatch(fixHealthCheckEndpointPath(logs, snap()));
  applyBatch(fixHealthCheckInterval(logs, snap()));
  applyBatch(fixHealthCheckDependencies(logs, snap()));
  applyBatch(fixHealthCheckHTTPS(logs, snap()));
  applyBatch(fixHealthCheckPort(logs, snap()));
  applyBatch(fixLivenessReadinessProbes(logs, snap()));
  applyBatch(fixStartupProbeTimeout(logs, snap()));
  applyBatch(fixHealthCheckResponseCode(logs, snap()));
  // Deployment cross-category — Section G (load balancer)
  applyBatch(fixALBTargetGroupHealthCheck(logs, snap()));
  applyBatch(fixNGINXProxyReadTimeout(logs, snap()));
  applyBatch(fixNLBPreserveClientIP(logs, snap()));
  applyBatch(fixCORSHeadersLB(logs, snap()));
  applyBatch(fixHTTPSRedirectLB(logs, snap()));
  applyBatch(fixLBStickySessions(logs, snap()));
  applyBatch(fixLBDrainingTimeout(logs, snap()));
  applyBatch(fixTraefikRouteConfig(logs, snap()));

  // Advanced cross-category
  applyBatch(fixMissingDockerLayer(logs, snap()));
  applyBatch(fixPortBindingConflict(logs, snap()));
  applyBatch(fixDockerImagePullFailure(logs, snap()));
  applyBatch(fixServiceUnavailable(logs, snap()));
  applyBatch(fixLoadBalancerRouting(logs, snap()));
  applyBatch(fixConnectionDraining(logs, snap()));
  applyBatch(fixCanaryDeployment(logs, snap()));
  applyBatch(fixInvalidAPIResponse(logs, snap()));
  applyBatch(fixBrokenThirdPartyIntegration(logs, snap()));
  applyBatch(fixSchemaValidationFailure(logs, snap()));
  applyBatch(fixGraphQLQueryFailure(logs, snap()));
  applyBatch(fixWaitForDatabase(logs, snap()));
  applyBatch(fixQueryExecutionFailure(logs, snap()));
  applyBatch(fixReplicationLag(logs, snap()));
  // Database cross-category — Section A (migration)
  applyBatch(fixFlywayCIConfig(logs, snap()));
  applyBatch(fixLiquibaseChangelog(logs, snap()));
  applyBatch(fixPrismaMigrateDeploy(logs, snap()));
  applyBatch(fixAlembicRevisionCheck(logs, snap()));
  applyBatch(fixRailsMigrationIdempotent(logs, snap()));
  applyBatch(fixKnexMigrationSource(logs, snap()));
  applyBatch(fixSequelizeMigrationState(logs, snap()));
  applyBatch(fixGooseMigrationVersion(logs, snap()));
  applyBatch(fixMigrationRollbackStep(logs, snap()));
  applyBatch(fixMigrationBaselineExisting(logs, snap()));
  // Database cross-category — Section B (connection)
  applyBatch(fixPGConnectionPool(logs, snap()));
  applyBatch(fixMySQLConnectionPool(logs, snap()));
  applyBatch(fixMongoConnectionTimeout(logs, snap()));
  applyBatch(fixRedisConnectionRetry(logs, snap()));
  applyBatch(fixDBConnectionSSL(logs, snap()));
  applyBatch(fixDBConnectionKeepalive(logs, snap()));
  applyBatch(fixDBConnectionEnvValidation(logs, snap()));
  applyBatch(fixDBConnectionProxyTimeout(logs, snap()));
  applyBatch(fixDBNetworkPolicyCIJob(logs, snap()));
  // Database cross-category — Section C (deadlock)
  applyBatch(fixDeadlockRetryLogic(logs, snap()));
  applyBatch(fixDeadlockLockTimeout(logs, snap()));
  applyBatch(fixDeadlockIsolationLevel(logs, snap()));
  applyBatch(fixDeadlockRowLevelLocking(logs, snap()));
  applyBatch(fixDeadlockMonitoring(logs, snap()));
  applyBatch(fixDeadlockCISerialRun(logs, snap()));
  applyBatch(fixDeadlockIndexForUpdate(logs, snap()));
  applyBatch(fixDeadlockConcurrencyGroup(logs, snap()));
  // Database cross-category — Section D (schema mismatch)
  applyBatch(fixSchemaDriftDetection(logs, snap()));
  applyBatch(fixPrismaSchemaSync(logs, snap()));
  applyBatch(fixTypeORMSchemaDrop(logs, snap()));
  applyBatch(fixDjangoMakeMigrationsCheck(logs, snap()));
  applyBatch(fixRailsSchemaLoad(logs, snap()));
  applyBatch(fixFlywaySchemaDiff(logs, snap()));
  applyBatch(fixLiquibaseValidate(logs, snap()));
  applyBatch(fixSchemaVersionTable(logs, snap()));
  applyBatch(fixSchemaBackwardCompat(logs, snap()));
  // Database cross-category — Section E (query execution)
  applyBatch(fixSlowQueryTimeout(logs, snap()));
  applyBatch(fixNPlusOneQueryDetect(logs, snap()));
  applyBatch(fixQueryAnalyzeExplain(logs, snap()));
  applyBatch(fixDBQueryLogging(logs, snap()));
  applyBatch(fixQueryMemoryLimit(logs, snap()));
  applyBatch(fixQueryResultPagination(logs, snap()));
  applyBatch(fixQueryTransactionWrapper(logs, snap()));
  applyBatch(fixQueryStatStatements(logs, snap()));
  // Database cross-category — Section F (missing index)
  applyBatch(fixCompositeIndexCreation(logs, snap()));
  applyBatch(fixPartialIndexCreation(logs, snap()));
  applyBatch(fixGINIndexForJSONB(logs, snap()));
  applyBatch(fixForeignKeyIndex(logs, snap()));
  applyBatch(fixUniqueIndexConstraint(logs, snap()));
  applyBatch(fixIndexStatisticsUpdate(logs, snap()));
  applyBatch(fixIndexBloatReindex(logs, snap()));
  applyBatch(fixQueryPlannerHint(logs, snap()));
  // Database cross-category — Section G (transaction rollback)
  applyBatch(fixTransactionSavepoint(logs, snap()));
  applyBatch(fixTransactionIsolationLevel(logs, snap()));
  applyBatch(fixTransactionTimeout(logs, snap()));
  applyBatch(fixTransactionDeadlockRetry(logs, snap()));
  applyBatch(fixTransactionConnectionReturn(logs, snap()));
  applyBatch(fixNestedTransactionPrisma(logs, snap()));
  applyBatch(fixTransactionRollbackLogging(logs, snap()));
  applyBatch(fixAtomicMigrationTransaction(logs, snap()));
  // Database cross-category — Section H (replication lag)
  applyBatch(fixReadWriteSplit(logs, snap()));
  applyBatch(fixReplicationSlotMonitor(logs, snap()));
  applyBatch(fixSynchronousCommit(logs, snap()));
  applyBatch(fixReplicaHealthCheck(logs, snap()));
  applyBatch(fixLogicalReplicationSetup(logs, snap()));
  applyBatch(fixReplicationMonitoringStep(logs, snap()));
  applyBatch(fixCDCEventStreamLag(logs, snap()));
  applyBatch(fixReplicationFailoverConfig(logs, snap()));
  applyBatch(fixPythonPath(logs, snap()));
  applyBatch(fixAPIVersionHeader(logs, snap()));
  applyBatch(fixGHCLIAuth(logs, snap()));
  applyBatch(fixGitLabCrossProjectToken(logs, snap()));
  applyBatch(fixAdvancedGitLabCrossProjectToken(logs, snap()));
  applyBatch(fixGitLabDetachedHead(logs, snap()));
  // Docker cross-category — Section A (build)
  applyBatch(fixDockerBuildContextTooLarge(logs, snap()));
  applyBatch(fixDockerBuildArgMissing(logs, snap()));
  applyBatch(fixDockerMultiStageBuild(logs, snap()));
  staticRule(fixDockerRUNLayerMerge);
  staticRule(fixDockerAPTGetUpdate);
  staticRule(fixDockerNPMInstallProd);
  staticRule(fixDockerPipNoCacheDir);
  staticRule(fixDockerCopyOrderForCache);
  staticRule(fixDockerShellToExecForm);
  applyBatch(fixDockerBuildPlatformArg(logs, snap()));
  applyBatch(fixDockerQEMUSetup(logs, snap()));
  staticRule(fixDockerLayerCleanup);
  // Docker cross-category — Section B (layer cache)
  staticRule(fixDockerGHACacheMount);
  staticRule(fixDockerRegistryLayerCache);
  applyBatch(fixDockerManifestUnknown(logs, snap()));
  applyBatch(fixDockerPullRetryOnBlob(logs, snap()));
  staticRule(fixDockerBuildKitCacheMount);
  staticRule(fixDockerSetupBuildx);
  staticRule(fixDockerMetadataAction);
  staticRule(fixDockerServicePullPolicy);
  // Docker cross-category — Section C (Dockerfile syntax)
  applyBatch(fixDockerfileHeredocSyntax(logs, snap()));
  applyBatch(fixDockerfileEnvVsArg(logs, snap()));
  staticRule(fixDockerfileCmdEntrypointInteraction);
  applyBatch(fixDockerfileJSONArraySyntax(logs, snap()));
  staticRule(fixDockerfileAddVsCopy);
  staticRule(fixDockerfileWorkdirAbsolute);
  staticRule(fixDockerfileLabelFormat);
  staticRule(fixDockerfileNonRootUser);
  staticRule(fixDockerignoreSecrets);
  applyBatch(fixDockerfileWildcardCopy(logs, snap()));
  // Docker cross-category — Section D (startup)
  staticRule(fixDockerTiniInit);
  staticRule(fixDockerEntrypointEnvCheck);
  applyBatch(fixDockerWaitForDependencies(logs, snap()));
  staticRule(fixDockerStopSignal);
  staticRule(fixDockerTimezone);
  applyBatch(fixDockerUlimits(logs, snap()));
  applyBatch(fixDockerResourceLimits(logs, snap()));
  applyBatch(fixDockerRestartPolicy(logs, snap()));
  staticRule(fixDockerLoggingConfig);
  staticRule(fixDockerStartupHealthcheck);
  // Docker cross-category — Section E (ports)
  applyBatch(fixDockerRandomPortAssignment(logs, snap()));
  applyBatch(fixDockerNetworkSubnetConflict(logs, snap()));
  applyBatch(fixDockerIPv6BindingConflict(logs, snap()));
  staticRule(fixDockerComposePortFormat);
  staticRule(fixDockerServiceContainerPorts);
  // Docker cross-category — Section F (registry auth)
  applyBatch(fixDockerGHCRLogin(logs, snap()));
  applyBatch(fixDockerECRLogin(logs, snap()));
  applyBatch(fixDockerACRLoginStep(logs, snap()));
  applyBatch(fixDockerGARLoginStep(logs, snap()));
  applyBatch(fixDockerHubAccessToken(logs, snap()));
  applyBatch(fixDockerPrivateRegistryCA(logs, snap()));
  staticRule(fixDockerCredentialHelper);
  // Docker cross-category — Section G (image pull)
  staticRule(fixDockerImageDigestPin);
  applyBatch(fixDockerRegistryPathFormat(logs, snap()));
  applyBatch(fixDockerTagFallback(logs, snap()));
  applyBatch(fixDockerComposePrivateImageAuth(logs, snap()));
  applyBatch(fixDockerAlpineApkMirror(logs, snap()));
  staticRule(fixDockerTrivyScanStep);
  applyBatch(fixDockerPullPlatformMismatch(logs, snap()));
  // Docker cross-category — Section H (volumes)
  staticRule(fixDockerNamedVolumes);
  applyBatch(fixDockerVolumeSelinuxLabel(logs, snap()));
  applyBatch(fixDockerBindMountAbsolutePath(logs, snap()));
  staticRule(fixDockerVolumeReadOnly);
  applyBatch(fixDockerTmpfsMount(logs, snap()));
  applyBatch(fixDockerNFSVolumeOptions(logs, snap()));
  applyBatch(fixDockerVolumeDriverConfig(logs, snap()));
  staticRule(fixDockerComposeInit);
  // API cross-category — Section A (timeout)
  applyBatch(fixAPIConnectTimeout(logs, snap()));
  applyBatch(fixAxiosTimeout(logs, snap()));
  applyBatch(fixFetchAbortController(logs, snap()));
  applyBatch(fixServiceMeshTimeout(logs, snap()));
  applyBatch(fixGRPCDeadline(logs, snap()));
  applyBatch(fixGraphQLRequestTimeout(logs, snap()));
  applyBatch(fixAPIGatewayIntegrationTimeout(logs, snap()));
  applyBatch(fixCurlRetryFlags(logs, snap()));
  applyBatch(fixJobAPICallTimeout(logs, snap()));
  // API cross-category — Section B (rate limiting)
  applyBatch(fixGitHubAPIRateLimit(logs, snap()));
  applyBatch(fixRetryAfterHeader(logs, snap()));
  applyBatch(fixNpmPublishRateLimit(logs, snap()));
  applyBatch(fixAPIBulkBatching(logs, snap()));
  applyBatch(fixLeakyBucketSleep(logs, snap()));
  applyBatch(fixStripeRateLimit(logs, snap()));
  applyBatch(fixGitLabAPIThrottle(logs, snap()));
  applyBatch(fixSendGridRateLimit(logs, snap()));
  applyBatch(fixDockerHubAnonymousPullLimit(logs, snap()));
  // API cross-category — Section C (invalid response)
  applyBatch(fixAPIResponseJSONParse(logs, snap()));
  applyBatch(fixAPIEmptyResponseGuard(logs, snap()));
  applyBatch(fixRedirectHandling(logs, snap()));
  applyBatch(fixAPIStatusCodeRange(logs, snap()));
  applyBatch(fixAPIContentTypeCheck(logs, snap()));
  applyBatch(fixAPIResponseCaching(logs, snap()));
  applyBatch(fixAPIEnvelopeUnwrap(logs, snap()));
  applyBatch(fixAPIErrorBodyParsing(logs, snap()));
  // API cross-category — Section D (webhook)
  applyBatch(fixWebhookHMACVerification(logs, snap()));
  applyBatch(fixWebhookReplayProtection(logs, snap()));
  applyBatch(fixWebhookIdempotencyKey(logs, snap()));
  applyBatch(fixWebhookTimeoutResponse(logs, snap()));
  applyBatch(fixWebhookPayloadSize(logs, snap()));
  applyBatch(fixWebhookIPAllowlist(logs, snap()));
  applyBatch(fixWebhookTLSValidation(logs, snap()));
  applyBatch(fixGitHubWebhookEvents(logs, snap()));
  // API cross-category — Section E (third-party)
  applyBatch(fixSentryDSNEnvVar(logs, snap()));
  applyBatch(fixDatadogAgentConfig(logs, snap()));
  applyBatch(fixSonarCloudQualityGate(logs, snap()));
  applyBatch(fixCodecovTokenMissing(logs, snap()));
  applyBatch(fixSnykAuthToken(logs, snap()));
  applyBatch(fixPagerdutyIntegration(logs, snap()));
  applyBatch(fixJiraIntegrationConfig(logs, snap()));
  applyBatch(fixNewRelicLicenseKey(logs, snap()));
  // API cross-category — Section F (schema validation)
  applyBatch(fixOpenAPISpectralLint(logs, snap()));
  applyBatch(fixJSONSchemaVersion(logs, snap()));
  applyBatch(fixAJVStrictMode(logs, snap()));
  applyBatch(fixProtobufSchemaBreaking(logs, snap()));
  applyBatch(fixOpenAPIRequestValidator(logs, snap()));
  applyBatch(fixSchemaRegistryCompat(logs, snap()));
  applyBatch(fixGraphQLSchemaLint(logs, snap()));
  applyBatch(fixZodSchemaValidation(logs, snap()));
  // API cross-category — Section G (GraphQL)
  applyBatch(fixGraphQLIntrospectionQuery(logs, snap()));
  applyBatch(fixGraphQLFragmentDefinition(logs, snap()));
  applyBatch(fixGraphQLNullableFields(logs, snap()));
  applyBatch(fixGraphQLPersistQuery(logs, snap()));
  applyBatch(fixGraphQLDeprecatedField(logs, snap()));
  applyBatch(fixGraphQLCORSHeaders(logs, snap()));
  applyBatch(fixGraphQLBatchRequest(logs, snap()));
  // API cross-category — Section H (REST endpoint)
  staticRule(fixRESTBaseURLEnvVar);
  applyBatch(fixRESTVersionPrefix(logs, snap()));
  applyBatch(fixRESTMethodMismatch(logs, snap()));
  applyBatch(fixRESTTrailingSlash(logs, snap()));
  applyBatch(fixRESTAuthHeader(logs, snap()));
  applyBatch(fixRESTContentTypeHeader(logs, snap()));
  staticRule(fixRESTEndpointEnvMatrix);
  applyBatch(fixRESTIdempotencyHeader(logs, snap()));
  applyBatch(fixRESTResponseTimeLogging(logs, snap()));
  // Runtime cross-category
  applyBatch(fixNullDerefOptionalChain(logs, ciSnap()));
  applyBatch(fixPythonNoneCheck(logs, snap()));
  applyBatch(fixGoNilPointerDeref(logs, snap()));
  applyBatch(fixRustUnwrapToExpect(logs, referencedSnap()));
  applyBatch(fixJavaNPEGuard(logs, snap()));
  applyBatch(fixCSharpNullConditional(logs, snap()));
  applyBatch(fixArrayBoundsCheck(logs, snap()));
  applyBatch(fixPythonMypyCheck(logs, snap()));
  applyBatch(fixPyrightTypeCheck(logs, snap()));
  applyBatch(fixGoTypeAssertion(logs, snap()));
  applyBatch(fixRustTypeCast(logs, snap()));
  applyBatch(fixPHPStrictTypes(logs, snap()));
  applyBatch(fixRubySorbetTypeCheck(logs, snap()));
  applyBatch(fixLoopIterationGuard(logs, snap()));
  applyBatch(fixPythonTestHangTimeout(logs, snap()));
  applyBatch(fixJestTestHangTimeout(logs, snap()));
  applyBatch(fixNodeEventListenerLeak(logs, ciSnap()));
  applyBatch(fixAsyncRetryMaxCap(logs, snap()));
  applyBatch(fixJVMStackSize(logs, snap()));
  applyBatch(fixPythonConfTestRecursion(logs, snap()));
  applyBatch(fixRubyStackSize(logs, snap()));
  applyBatch(fixDotNetStackSize(logs, snap()));
  applyBatch(fixRustStackSize(logs, snap()));
  applyBatch(fixGoStackTrace(logs, snap()));
  applyBatch(fixGoMemoryTuning(logs, snap()));
  applyBatch(fixPythonMemoryLimit(logs, snap()));
  applyBatch(fixDockerMemoryLimit(logs, snap()));
  applyBatch(fixUlimitVirtualMemory(logs, snap()));
  applyBatch(fixK8sPodMemoryLimit(logs, snap()));
  applyBatch(fixAddressSanitizerBuild(logs, snap()));
  applyBatch(fixPythonFaultHandler(logs, snap()));
  applyBatch(fixRustMiriCheck(logs, snap()));
  applyBatch(fixValgrindMemCheck(logs, snap()));
  applyBatch(fixCoreDumpUpload(logs, snap()));
  applyBatch(fixNodeNativeAddonCrash(logs, snap()));
  applyBatch(fixExpressErrorMiddleware(logs, ciSnap()));
  applyBatch(fixPromiseAllSettled(logs, ciSnap()));
  applyBatch(fixPythonExceptionLogging(logs, referencedSnap()));
  applyBatch(fixJavaUncaughtExceptionHandler(logs, snap()));
  applyBatch(fixDotNetUnhandledException(logs, snap()));
  applyBatch(fixSentryRuntimeCapture(logs, snap()));
  applyBatch(fixBrowserGlobalErrorHandler(logs, snap()));
  applyBatch(fixRuntimeExceptionDiagnostics(logs, snap()));

  // ════════════════════════════════════════════════════════════════════════
  // CODE — surgical source edits (all log-gated: each fires only when the CI
  // output names the exact problem, and edits only the file/line it names)
  // ════════════════════════════════════════════════════════════════════════
  // Removed lines stay as placeholders until every line-precise fixer has run, so each
  // one edits the line the tool reported. Python lint runs last: B006 inserts lines.
  // Format-exact parsers (compiler / linter rows with file:line) read the complete logs.
  withStableLineNumbers(() => {
    applyBatch(fixCompilerSuggestions(reportLogs, snap()));
    applyBatch(fixUnusedImports(reportLogs, snap()));
    applyBatch(fixPythonUnusedImports(reportLogs, snap()));
    applyBatch(fixPreferConst(reportLogs, snap()));
    applyBatch(fixEslintRuleViolations(reportLogs, snap()));
    applyBatch(fixDebuggerStatements(logs, snap()));
    applyBatch(fixWhitespaceLint(logs, snap()));
    applyBatch(fixFocusedTests(logs, snap()));
    applyBatch(fixUnusedTsExpectError(reportLogs, snap()));
    applyBatch(fixMissingExport(reportLogs, snap()));
    applyBatch(fixNullDerefAtStackFrame(logs, snap()));
    applyBatch(fixPythonModulePath(logs, snap()));
    applyBatch(fixPyYamlLoad(logs, snap()));
    applyBatch(fixPythonLintViolations(reportLogs, snap()));
  });
  for (const [path, content] of working) if (hasLinePlaceholders(content)) working.set(path, stripLinePlaceholders(content));
  applyBatch(fixMissingNpmPackage(logs, snap()));
  applyBatch(fixMissingPythonPackage(logs, snap()));

  // ════════════════════════════════════════════════════════════════════════
  // MANIFESTS — dependency versions, engines, test environment (log-gated,
  // each edits the manifest governing the failing job's directory)
  // ════════════════════════════════════════════════════════════════════════
  applyBatch(fixUnavailablePinnedVersion(reportLogs, snap()));
  applyBatch(fixIncompatiblePythonPins(reportLogs, snap()));
  applyBatch(fixVulnerableDependencies(reportLogs, snap()));
  applyBatch(fixNodeEngineMismatch(logs, snap()));
  applyBatch(fixJestEnvironmentMissing(logs, snap()));
  applyBatch(fixMissingRequirementsFile(logs, snap()));
  applyBatch(fixVirtualenvNotCreated(logs, snap()));
  applyBatch(fixChmodScript(logs, snap())); // log-gated: only scripts the log reports as "Permission denied"
  applyBatch(fixDockerfilePath(logs, snap()));
  applyBatch(fixDockerfileUnknownInstruction(logs, snap()));
  applyBatch(fixMissingBindSource(logs, snap()));
  applyBatch(fixZeroRevisionHistory(logs, snap()));
  applyBatch(fixArtifactPathMismatch(logs, snap()));
  // GitLab rejects only:/except: here ("config contains unknown keys: only") — rules: is the repair, not a preference
  if (/contains unknown keys?:\s*(?:only|except)\b/.test(logs)) applyBatch(fixGitLabOnlyExceptToRules(snap()));
  staticRule(fixComposeHostPortCollision);
  staticRule(fixK8sSelectorLabelMismatch);

  // Build output — one RuleFix per modified file
  return [...explanations.entries()].map(([path, exps]) => ({
    path,
    content: working.get(path)!,
    explanation: exps.join('; '),
    confidence: 100,
  }));
}
