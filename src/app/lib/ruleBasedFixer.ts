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

// ── Orchestrator ─────────────────────────────────────────────────────────────

export function applyRuleBasedFixes(
  category: ErrorCategory | ErrorCategory[],
  logs: string,
  files: Array<{ path: string; content: string }>,
): RuleFix[] {
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
  const confidences  = new Map<string, number[]>();

  function applyBatch(batch: RuleFix[]) {
    for (const fix of batch) {
      if (typeof fix.content !== 'string') continue;
      if (!fix.path || typeof fix.path !== 'string') continue;
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

  // ════════════════════════════════════════════════════════════════════════
  // SIMPLE — always-run rules (file-content based, safe for any category)
  // ════════════════════════════════════════════════════════════════════════
  applyBatch(fixYamlTabIndentation(snap()));
  applyBatch(fixYamlIndentationDepth(snap()));
  applyBatch(fixDuplicateYamlKey(snap()));
  applyBatch(fixMissingYamlColon(logs, snap()));
  applyBatch(fixIncorrectYamlBooleans(snap()));
  applyBatch(fixIncorrectExpressionDelimiter(snap()));
  applyBatch(fixStepUsesAndRun(snap()));
  applyBatch(fixMissingWorkflowTrigger(snap()));
  applyBatch(fixWorkflowTriggerTypo(snap()));
  applyBatch(fixIncorrectConfigHierarchy(snap()));
  applyBatch(fixMissingShebang(snap()));
  applyBatch(fixAptGetSudo(snap()));
  applyBatch(fixNpmCacheNolockfile(snap()));
  applyBatch(fixNpmCiToInstall(snap()));
  applyBatch(fixCodecovNonBlocking(snap()));
  applyBatch(fixArtifactIfNoFilesError(snap()));
  applyBatch(fixGradleWrapperPermission(snap()));
  applyBatch(fixPnpmWorkspaceBuild(snap()));
  applyBatch(fixCargoWorkspaceBuild(snap()));
  applyBatch(fixNextJsBuildConfig(snap()));
  applyBatch(fixPython2to3(snap()));
  applyBatch(fixRustToolchainFile(snap()));
  applyBatch(fixPrismaGenerate(snap()));
  applyBatch(fixGoGenerateStep(snap()));
  applyBatch(fixLernaBootstrap(logs, snap()));
  applyBatch(fixMakeParallelJobs(snap()));
  applyBatch(fixTailwindContentPaths(snap()));
  applyBatch(fixSvelteKitAdapter(snap()));
  applyBatch(fixRakeTask(snap()));
  applyBatch(fixRubyNativeExtensions(logs, snap()));
  applyBatch(fixFlutterSDKConstraint(logs, snap()));
  applyBatch(fixMissingNodeEnv(snap()));
  applyBatch(fixMissingCIEnvFlag(snap()));
  applyBatch(fixPromoteRepeatedEnvVars(snap()));
  applyBatch(fixVariableScopeIssue(snap()));
  applyBatch(fixAddInstallStep(snap()));
  applyBatch(fixMissingYarnInstallStep(snap()));
  applyBatch(fixMissingComposerInstall(snap()));
  applyBatch(fixMissingPoetryInstall(snap()));
  applyBatch(fixMissingPipenvInstall(snap()));
  applyBatch(fixMissingSetupPython(snap()));
  applyBatch(fixMissingSetupJava(snap()));
  applyBatch(fixMissingSetupGo(snap()));
  applyBatch(fixCondaEnvironmentSetup(snap()));
  applyBatch(fixNpmEnginesCheck(snap()));
  applyBatch(fixNvmrcVersionMismatch(snap()));
  applyBatch(fixNpmCacheRestoreKeys(snap()));
  applyBatch(fixPipCache(snap()));
  applyBatch(fixMavenCache(snap()));
  applyBatch(fixGradleCache(snap()));
  applyBatch(fixComposerCache(snap()));
  applyBatch(fixGoModCache(snap()));
  applyBatch(fixCreateRequirementsTxt(snap()));
  applyBatch(fixRequirementsPinning(snap()));
  applyBatch(fixPipNoCacheDir(snap()));
  applyBatch(fixNpmRegistryAuth(snap()));
  applyBatch(fixPipPrivateIndex(snap()));
  applyBatch(fixCreateDotEnvExample(snap()));
  // NEW always-run: syntax + environment + deps + build
  applyBatch(fixRunnerLabelTypo(snap()));
  applyBatch(fixMissingCheckoutStep(snap()));
  applyBatch(fixInvalidCronExpression(snap()));
  applyBatch(fixGitLabOnlyExceptToRules(snap()));
  applyBatch(fixMultilineRunScript(snap()));
  applyBatch(fixMissingWorkflowCallTrigger(snap()));
  applyBatch(fixLinuxCommandsOnWindows(snap()));
  applyBatch(fixBashSyntaxInPosixSh(snap()));
  applyBatch(fixHardcodedSecretInYaml(snap()));
  applyBatch(fixTerraformEnvVars(snap()));
  applyBatch(fixDeprecatedSaveState(snap()));
  applyBatch(fixMissingGitHubTokenPermissions(snap()));
  applyBatch(fixGitLabVariableMasking(snap()));
  applyBatch(fixIncorrectNodeEnvValue(snap()));
  applyBatch(fixDotEnvInGitignore(snap()));
  applyBatch(fixUndeclaredEnvVarReference(snap()));
  applyBatch(fixMissingNpmPublishToken(snap()));
  applyBatch(fixMissingDockerRegistrySecrets(snap()));
  applyBatch(fixMissingAwsRegion(snap()));
  applyBatch(fixPythonEnvVars(snap()));
  applyBatch(fixJavaEnvVars(snap()));
  applyBatch(fixGoEnvVars(snap()));
  applyBatch(fixCargoEnvVars(snap()));
  applyBatch(fixStepOutputScopeError(snap()));
  applyBatch(fixMissingJobOutputsDeclaration(snap()));
  applyBatch(fixEventInputScope(snap()));
  applyBatch(fixDotNetEnvVars(snap()));
  applyBatch(fixRubyEnvVars(snap()));
  applyBatch(fixPhpEnvVars(snap()));
  applyBatch(fixGoogleCloudEnvVars(snap()));
  applyBatch(fixAzureEnvVars(snap()));
  applyBatch(fixVercelDeployEnvVars(snap()));
  applyBatch(fixSentryEnvVars(snap()));
  applyBatch(fixSecretsInheritance(snap()));
  applyBatch(fixExportVarCrossStep(snap()));
  applyBatch(fixMissingSecretsContextUsage(snap()));
  applyBatch(fixHuskyCI(snap()));
  applyBatch(fixMavenWrapperPermission(snap()));
  applyBatch(fixYarnBerrySetup(snap()));
  applyBatch(fixMissingEditorConfig(snap()));
  applyBatch(fixArtifactRetentionDays(snap()));
  applyBatch(fixRetentionDaysType(snap()));
  applyBatch(fixDenyLicensesType(snap()));
  applyBatch(fixContentsNonePermission(snap()));
  applyBatch(fixQuotedExpressionLiteral(snap()));
  applyBatch(fixExternalServiceJobNonBlocking(snap()));
  applyBatch(fixFailFastMatrix(snap()));
  applyBatch(fixGitLabMissingCache(snap()));

  // ════════════════════════════════════════════════════════════════════════
  // INTERMEDIATE — always-run pipeline + git hygiene rules
  // ════════════════════════════════════════════════════════════════════════
  applyBatch(fixDeprecatedSetOutput(snap()));
  applyBatch(fixDeprecatedSetEnv(snap()));
  applyBatch(fixMergeConflictMarkers(snap()));
  applyBatch(fixGitLabStageOrder(snap()));
  applyBatch(fixGitLabOptionalStages(snap()));
  applyBatch(fixMissingJobNeeds(snap()));
  applyBatch(fixSecurityJobNonBlocking(snap()));
  applyBatch(fixMissingReportsDir(snap()));
  applyBatch(fixMissingDispatchInputs(snap()));
  applyBatch(fixGitLabIncludePath(snap()));
  // NEW always-run: git + pipeline + config hygiene
  applyBatch(fixHuskyPreCommitCI(snap()));
  applyBatch(fixMissingJobOutputs(snap()));
  applyBatch(fixRecursivePipelineTrigger(snap()));
  applyBatch(fixGitLineEndings(logs, snap()));
  applyBatch(fixGitLabDefaultBranch(snap()));
  // Config always-run
  applyBatch(fixMissingWorkflowName(snap()));
  applyBatch(fixIfAlwaysSyntax(snap()));
  applyBatch(fixWorkflowIfCondition(snap()));
  applyBatch(fixStepUsesAndRunConflict(snap()));
  applyBatch(fixDuplicateEnvKey(snap()));
  applyBatch(fixDuplicatePermissions(snap()));
  applyBatch(fixDockerComposeVersionField(snap()));
  applyBatch(fixGitLabWorkflowRules(snap()));
  applyBatch(fixGitLabResourceGroup(snap()));
  applyBatch(fixGitLabEnvironmentConfig(snap()));
  applyBatch(fixGitLabRulesNeverMatch(snap()));
  applyBatch(fixMissingDockerignore(snap()));
  applyBatch(fixMissingSecretsContext(snap()));
  applyBatch(fixSecretToEnvMapping(snap()));
  applyBatch(fixEnvContextScope(snap()));
  applyBatch(fixReusableWorkflowPin(snap()));
  // Pipeline always-run
  applyBatch(fixConcurrencyForPR(snap()));
  applyBatch(fixPullRequestTargetSecurity(snap()));
  applyBatch(fixPushTagsPattern(snap()));
  applyBatch(fixPathFilterTrigger(snap()));
  applyBatch(fixArtifactIfNoFilesFound(snap()));
  applyBatch(fixCacheRestoreKeys(snap()));
  applyBatch(fixSetupActionBuiltinCache(snap()));
  applyBatch(fixCacheKeyHashFiles(snap()));
  applyBatch(fixGitLabArtifactConfig(snap()));
  applyBatch(fixGitLabCachePolicy(snap()));
  applyBatch(fixWorkflowDispatchInputs(snap()));
  applyBatch(fixJobOrderingWithNeeds(snap()));
  applyBatch(fixDanglingNeedsReference(logs, snap()));
  applyBatch(fixNeedsContextKeyMismatch(snap()));
  applyBatch(fixWrongResultValueInIf(snap()));
  applyBatch(fixMatrixNodeVersionKey(snap()));
  applyBatch(fixMissingStepIdForOutput(snap()));
  applyBatch(fixSonarCloudConfig(snap()));
  applyBatch(fixPostgresServiceConfig(snap()));
  applyBatch(fixBarrierGateJob(snap()));
  applyBatch(fixWorkflowLevelEnvSharing(snap()));

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
  applyBatch(fixMissingDockerignore(snap()));
  applyBatch(fixDockerBaseImagePin(snap()));
  applyBatch(fixEnableDockerBuildKit(snap()));
  applyBatch(fixSlackNotificationSecret(snap()));
  applyBatch(fixGitLabDeployEnvironment(snap()));
  applyBatch(fixSSHDeployNonBlocking(snap()));
  applyBatch(fixK8sRolloutWait(snap()));

  // ════════════════════════════════════════════════════════════════════════
  // CATEGORY-SPECIFIC rules — targeted at the diagnosed failure type
  // ════════════════════════════════════════════════════════════════════════

  if (hasCategory('docker_auth')) {
    applyBatch(fixDockerJobOnPushOnly(snap()));
    applyBatch(fixDockerAndDeployJobsNonBlocking(snap()));
    applyBatch(fixCreateMinimalDockerfile(snap()));
    applyBatch(fixGitLabDockerJobGuard(snap()));
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
    applyBatch(fixDockerCredentialHelper(snap()));
  }

  if (hasCategory('docker_rate_limit')) {
    applyBatch(fixDockerHubRateLimit(logs, snap()));
    applyBatch(fixDockerJobOnPushOnly(snap()));
  }

  if (hasCategory('docker_build')) {
    applyBatch(fixCreateMinimalDockerfile(snap()));
    applyBatch(fixDockerBaseImagePin(snap()));
    applyBatch(fixDockerPortExpose(snap()));
    applyBatch(fixMissingDockerLayer(logs, snap()));
    applyBatch(fixDockerImagePullFailure(logs, snap()));
    // Section A — Build failure extended
    applyBatch(fixDockerBuildContextTooLarge(logs, snap()));
    applyBatch(fixDockerBuildArgMissing(logs, snap()));
    applyBatch(fixDockerMultiStageBuild(logs, snap()));
    applyBatch(fixDockerRUNLayerMerge(snap()));
    applyBatch(fixDockerAPTGetUpdate(snap()));
    applyBatch(fixDockerNPMInstallProd(snap()));
    applyBatch(fixDockerPipNoCacheDir(snap()));
    applyBatch(fixDockerCopyOrderForCache(snap()));
    applyBatch(fixDockerShellToExecForm(snap()));
    applyBatch(fixDockerBuildPlatformArg(logs, snap()));
    applyBatch(fixDockerQEMUSetup(logs, snap()));
    applyBatch(fixDockerLayerCleanup(snap()));
    // Section B — Layer cache
    applyBatch(fixDockerGHACacheMount(snap()));
    applyBatch(fixDockerRegistryLayerCache(snap()));
    applyBatch(fixDockerManifestUnknown(logs, snap()));
    applyBatch(fixDockerPullRetryOnBlob(logs, snap()));
    applyBatch(fixDockerBuildKitCacheMount(snap()));
    applyBatch(fixDockerSetupBuildx(snap()));
    applyBatch(fixDockerMetadataAction(snap()));
    applyBatch(fixDockerServicePullPolicy(snap()));
  }

  if (hasCategory('missing_docker_layer')) {
    applyBatch(fixMissingDockerLayer(logs, snap()));
    applyBatch(fixDockerGHACacheMount(snap()));
    applyBatch(fixDockerRegistryLayerCache(snap()));
    applyBatch(fixDockerManifestUnknown(logs, snap()));
    applyBatch(fixDockerPullRetryOnBlob(logs, snap()));
    applyBatch(fixDockerBuildKitCacheMount(snap()));
    applyBatch(fixDockerSetupBuildx(snap()));
    applyBatch(fixDockerMetadataAction(snap()));
    applyBatch(fixDockerServicePullPolicy(snap()));
  }

  if (hasCategory('dockerfile_syntax')) {
    applyBatch(fixDockerfileHeredocSyntax(logs, snap()));
    applyBatch(fixDockerfileEnvVsArg(logs, snap()));
    applyBatch(fixDockerfileCmdEntrypointInteraction(snap()));
    applyBatch(fixDockerfileJSONArraySyntax(logs, snap()));
    applyBatch(fixDockerfileAddVsCopy(snap()));
    applyBatch(fixDockerfileWorkdirAbsolute(snap()));
    applyBatch(fixDockerfileLabelFormat(snap()));
    applyBatch(fixDockerfileNonRootUser(snap()));
    applyBatch(fixDockerignoreSecrets(snap()));
    applyBatch(fixDockerfileWildcardCopy(logs, snap()));
  }

  if (hasCategory('container_startup')) {
    applyBatch(fixDockerTiniInit(snap()));
    applyBatch(fixDockerEntrypointEnvCheck(snap()));
    applyBatch(fixDockerWaitForDependencies(logs, snap()));
    applyBatch(fixDockerStopSignal(snap()));
    applyBatch(fixDockerTimezone(snap()));
    applyBatch(fixDockerUlimits(logs, snap()));
    applyBatch(fixDockerResourceLimits(logs, snap()));
    applyBatch(fixDockerRestartPolicy(logs, snap()));
    applyBatch(fixDockerLoggingConfig(snap()));
    applyBatch(fixDockerStartupHealthcheck(snap()));
  }

  if (hasCategory('container_health_failure')) {
    applyBatch(fixDockerHealthcheck(logs, snap()));
    applyBatch(fixWaitForDatabase(logs, snap()));
    applyBatch(fixDockerStartupHealthcheck(snap()));
    applyBatch(fixDockerWaitForDependencies(logs, snap()));
    applyBatch(fixDockerTiniInit(snap()));
  }

  if (hasCategory('registry_auth_failure')) {
    applyBatch(fixDockerGHCRLogin(logs, snap()));
    applyBatch(fixDockerECRLogin(logs, snap()));
    applyBatch(fixDockerACRLoginStep(logs, snap()));
    applyBatch(fixDockerGARLoginStep(logs, snap()));
    applyBatch(fixDockerHubAccessToken(logs, snap()));
    applyBatch(fixDockerPrivateRegistryCA(logs, snap()));
    applyBatch(fixDockerCredentialHelper(snap()));
    applyBatch(fixDockerHubRateLimit(logs, snap()));
  }

  if (hasCategory('volume_mount_failure')) {
    applyBatch(fixDockerNamedVolumes(snap()));
    applyBatch(fixDockerVolumeSelinuxLabel(logs, snap()));
    applyBatch(fixDockerBindMountAbsolutePath(logs, snap()));
    applyBatch(fixDockerVolumeReadOnly(snap()));
    applyBatch(fixDockerTmpfsMount(logs, snap()));
    applyBatch(fixDockerNFSVolumeOptions(logs, snap()));
    applyBatch(fixDockerVolumeDriverConfig(logs, snap()));
    applyBatch(fixDockerComposeInit(snap()));
    applyBatch(fixDockerVolumePermissions(logs, snap()));
  }

  if (hasCategory('missing_file')) {
    applyBatch(fixCreateMinimalDockerfile(snap()));
    applyBatch(fixMissingTsConfig(logs, snap()));
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
    applyBatch(fixSSHDeployNonBlocking(snap()));
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
  }

  if (hasCategory('node_version')) {
    applyBatch(fixNodeVersionPin(logs, snap()));
  }

  if (hasCategory('missing_dependency')) {
    applyBatch(fixMissingPnpmSetup(logs, snap()));
    applyBatch(fixMissingSetupPython(snap()));
    applyBatch(fixMissingSetupJava(snap()));
    applyBatch(fixMissingSetupGo(snap()));
    applyBatch(fixMissingComposerInstall(snap()));
    applyBatch(fixMissingPoetryInstall(snap()));
    applyBatch(fixMissingPipenvInstall(snap()));
    applyBatch(fixPeerDepConflict(logs, snap()));
    applyBatch(fixNpmOverrides(logs, snap()));
    applyBatch(fixYarnResolutions(logs, snap()));
    applyBatch(fixYarnFrozenLockfile(logs, snap()));
    applyBatch(fixPipDependencyConflict(logs, snap()));
    applyBatch(fixPipIgnoreRequiresPython(logs, snap()));
    applyBatch(fixMavenDependencyConflict(logs, snap()));
    applyBatch(fixPipNoCacheDir(snap()));
    applyBatch(fixPipUpgrade(logs, snap()));
    applyBatch(fixCorruptedLockfile(logs, snap()));
    applyBatch(fixYarnLockfileCorruption(logs, snap()));
    applyBatch(fixPoetryLockfileCorruption(logs, snap()));
    applyBatch(fixGemfileLockCorruption(logs, snap()));
    applyBatch(fixPnpmLockfileCorruption(logs, snap()));
    applyBatch(fixMissingVirtualEnv(logs, snap()));
    applyBatch(fixPoetryVirtualEnv(logs, snap()));
    applyBatch(fixCondaEnvironmentSetup(snap()));
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
    applyBatch(fixPipNoCacheDir(snap()));
    applyBatch(fixPythonPath(logs, snap()));
    applyBatch(fixCreateRequirementsTxt(snap()));
  }

  if (hasCategory('env_missing')) {
    applyBatch(fixOptionalSecretSteps(logs, snap()));
    applyBatch(fixEnvVarWithDefault(logs, snap()));
    applyBatch(fixGitLabMissingVariables(logs, snap()));
    applyBatch(fixCreateDotEnvExample(snap()));
    applyBatch(fixMissingAwsRegion(snap()));
    applyBatch(fixPythonEnvVars(snap()));
    applyBatch(fixJavaEnvVars(snap()));
    applyBatch(fixGoEnvVars(snap()));
    applyBatch(fixCargoEnvVars(snap()));
    applyBatch(fixUndeclaredEnvVarReference(snap()));
    applyBatch(fixStepOutputScopeError(snap()));
    applyBatch(fixMissingJobOutputsDeclaration(snap()));
    applyBatch(fixEventInputScope(snap()));
  }

  if (hasCategory('build_failure')) {
    // Category 1: Build script failure
    applyBatch(fixMissingBuildScript(logs, snap()));
    applyBatch(fixGradleWrapperPermission(snap()));
    applyBatch(fixGradleDaemonOOM(logs, snap()));
    applyBatch(fixMavenBuildScript(snap()));
    applyBatch(fixTurboPipelineConfig(logs, snap()));
    applyBatch(fixNxBuildSetup(logs, snap()));
    applyBatch(fixPnpmWorkspaceBuild(snap()));
    applyBatch(fixCargoWorkspaceBuild(snap()));
    applyBatch(fixAndroidGradleBuild(logs, snap()));
    applyBatch(fixShellScriptExitCodes(logs, snap()));
    // Category 2: Compilation failure
    applyBatch(fixCompilationFailure(logs, snap()));
    applyBatch(fixMissingTsConfig(logs, snap()));
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
    applyBatch(fixRustBinaryArtifact(snap()));
    applyBatch(fixDotNetPublishArtifact(snap()));
    applyBatch(fixGoArtifactPath(snap()));
    applyBatch(fixNextExportArtifact(snap()));
    applyBatch(fixDockerSaveArtifact(snap()));
    // Category 4: Invalid build target
    applyBatch(fixInvalidBuildTarget(logs, snap()));
    applyBatch(fixGradleTaskNotFound(logs, snap()));
    applyBatch(fixMavenGoalNotFound(logs, snap()));
    applyBatch(fixNpmWorkspaceScript(logs, snap()));
    applyBatch(fixTurboMissingTask(logs, snap()));
    applyBatch(fixBazelBuildTarget(logs, snap()));
    // Category 5: Unsupported runtime version
    applyBatch(fixNodeExperimentalFlags(logs, snap()));
    applyBatch(fixPython2to3(snap()));
    applyBatch(fixJavaReleaseFlag(logs, snap()));
    applyBatch(fixRustToolchainFile(snap()));
    applyBatch(fixDotNetTargetFramework(logs, snap()));
    applyBatch(fixGoModDirective(logs, snap()));
    applyBatch(fixSwiftToolsVersion(logs, snap()));
    applyBatch(fixOpenSSLLegacyProvider(snap()));
    applyBatch(fixRubyKeywordArgs(logs, snap()));
    applyBatch(fixPHPVersionCompat(logs, snap()));
    applyBatch(fixRubyNativeExtensions(logs, snap()));
    applyBatch(fixFlutterSDKConstraint(logs, snap()));
    // Extended Category 1
    applyBatch(fixPrismaGenerate(snap()));
    applyBatch(fixGoGenerateStep(snap()));
    applyBatch(fixLernaBootstrap(logs, snap()));
    applyBatch(fixCMakeBuildSetup(snap()));
    applyBatch(fixMakeParallelJobs(snap()));
    applyBatch(fixProtobufGenerate(snap()));
    applyBatch(fixDockerComposeBuildService(snap()));
    // Extended Category 2
    applyBatch(fixGraphQLCodegen(snap()));
    applyBatch(fixTailwindContentPaths(snap()));
    applyBatch(fixAngularBuildBudget(logs, snap()));
    applyBatch(fixSvelteKitAdapter(snap()));
    applyBatch(fixPostCSSConfig(logs, snap()));
    applyBatch(fixNuxtNitroPreset(snap()));
    // Extended Category 3
    applyBatch(fixLambdaZipPackage(snap()));
    applyBatch(fixNuGetPackageOutput(snap()));
    applyBatch(fixHelmChartPackage(snap()));
    applyBatch(fixElectronArtifactPath(snap()));
    applyBatch(fixPythonWheelBuild(snap()));
    // Extended Category 4
    applyBatch(fixRakeTask(snap()));
    applyBatch(fixMixTask(logs, snap()));
    applyBatch(fixSbtBuildTask(logs, snap()));
    // Cross-category
    applyBatch(fixPythonPath(logs, snap()));
    applyBatch(fixIncorrectFilePath(logs, snap()));
    applyBatch(fixInvalidJsonSyntax(logs, snap()));
    applyBatch(fixScriptTypo(logs, snap()));
    applyBatch(fixIncorrectVariableName(logs, snap()));
    applyBatch(fixShallowCloneFetchDepth(logs, snap()));
  }

  if (hasCategory('compilation_failure')) {
    applyBatch(fixCompilationFailure(logs, snap()));
    applyBatch(fixMissingTsConfig(logs, snap()));
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
    applyBatch(fixArtifactIfNoFilesError(snap()));
    applyBatch(fixGradleArtifactPath(logs, snap()));
    applyBatch(fixMavenArtifactPath(logs, snap()));
    applyBatch(fixRustBinaryArtifact(snap()));
    applyBatch(fixDotNetPublishArtifact(snap()));
    applyBatch(fixGoArtifactPath(snap()));
    applyBatch(fixNextExportArtifact(snap()));
    applyBatch(fixDockerSaveArtifact(snap()));
  }

  if (hasCategory('gradle_build_failure')) {
    applyBatch(fixGradleWrapperPermission(snap()));
    applyBatch(fixGradleDaemonOOM(logs, snap()));
    applyBatch(fixGradleTaskNotFound(logs, snap()));
    applyBatch(fixGradleArtifactPath(logs, snap()));
    applyBatch(fixKotlinJvmTarget(logs, snap()));
    applyBatch(fixAndroidGradleBuild(logs, snap()));
    applyBatch(fixJavaReleaseFlag(logs, snap()));
  }

  if (hasCategory('maven_build_failure')) {
    applyBatch(fixMavenBuildScript(snap()));
    applyBatch(fixMavenGoalNotFound(logs, snap()));
    applyBatch(fixMavenArtifactPath(logs, snap()));
    applyBatch(fixJavaCompilationError(logs, snap()));
    applyBatch(fixJavaReleaseFlag(logs, snap()));
    applyBatch(fixDotnetRestore(snap()));
  }

  if (hasCategory('runtime_version_error')) {
    applyBatch(fixNodeExperimentalFlags(logs, snap()));
    applyBatch(fixPython2to3(snap()));
    applyBatch(fixJavaReleaseFlag(logs, snap()));
    applyBatch(fixRustToolchainFile(snap()));
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
    applyBatch(fixNullReferenceException(logs, snap()));
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
    applyBatch(fixNullReferenceException(logs, snap()));
    applyBatch(fixNullDerefOptionalChain(logs, snap()));
    applyBatch(fixStrictNullChecks(logs, snap()));
    applyBatch(fixPythonNoneCheck(logs, snap()));
    applyBatch(fixGoNilPointerDeref(logs, snap()));
    applyBatch(fixRustUnwrapToExpect(logs, snap()));
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
    applyBatch(fixNodeEventListenerLeak(logs, snap()));
    applyBatch(fixAsyncRetryMaxCap(logs, snap()));
    applyBatch(fixJobTimeout(logs, snap()));
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
    applyBatch(fixUnhandledRejection(logs, snap()));
    applyBatch(fixAsyncTryCatch(logs, snap()));
    applyBatch(fixExpressErrorMiddleware(logs, snap()));
    applyBatch(fixPromiseAllSettled(logs, snap()));
    applyBatch(fixPythonExceptionLogging(logs, snap()));
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
    applyBatch(fixJestCIFlag(snap()));
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
    applyBatch(fixJestCIFlag(snap()));
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
    applyBatch(fixParallelJobTimeouts(snap()));
    applyBatch(fixStepLevelTimeout(logs, snap()));
    applyBatch(fixGitLabJobTimeout(logs, snap()));
    applyBatch(fixHangingProcessWatchdog(logs, snap()));
  }

  if (hasCategory('concurrency_issue')) {
    applyBatch(fixMissingConcurrencyGroup(snap()));
    applyBatch(fixConcurrencyForPR(snap()));
    applyBatch(fixBarrierGateJob(snap()));
    applyBatch(fixMatrixFanInSummary(snap()));
  }

  if (hasCategory('pipeline_stage_failure')) {
    applyBatch(fixShellStrictMode(logs, snap()));
    applyBatch(fixPipelineStageFailureDiagnostic(logs, snap()));
    applyBatch(fixFlakyStageContinueOnError(logs, snap()));
    applyBatch(fixGitLabIncrementalPipeline(snap()));
    applyBatch(fixWorkflowRunWait(snap()));
    applyBatch(fixPipelineFailureNotification(snap()));
    applyBatch(fixMatrixIncludeExclude(logs, snap()));
    applyBatch(fixFailedPipelineStageRetry(logs, snap()));
  }

  if (hasCategory('stage_order_error')) {
    applyBatch(fixGitLabStageOrder(snap()));
    applyBatch(fixGitLabStageOrdering(snap()));
    applyBatch(fixGitLabDAGPipeline(snap()));
    applyBatch(fixDanglingNeedsReference(logs, snap()));
    applyBatch(fixJobOrderingWithNeeds(snap()));
    applyBatch(fixMissingJobNeeds(snap()));
  }

  if (hasCategory('invalid_trigger')) {
    applyBatch(fixPushBranchFilter(snap()));
    applyBatch(fixWorkflowDispatchInputs(snap()));
    applyBatch(fixPullRequestTargetSecurity(snap()));
    applyBatch(fixCronScheduleExpression(logs, snap()));
    applyBatch(fixWorkflowCallContract(snap()));
    applyBatch(fixPushTagsPattern(snap()));
    applyBatch(fixPathFilterTrigger(snap()));
  }

  if (hasCategory('runner_unavailable')) {
    applyBatch(fixParallelJobTimeouts(snap()));
    applyBatch(fixMissingRunner(logs, snap()));
    applyBatch(fixCircularDependency(logs, snap()));
    applyBatch(fixRunnerGroupFallback(logs, snap()));
    applyBatch(fixLargerRunnerSpec(logs, snap()));
    applyBatch(fixJobContainerImage(logs, snap()));
    applyBatch(fixOfflineRunnerContinue(logs, snap()));
  }

  if (hasCategory('artifact_upload_failure')) {
    applyBatch(fixArtifactUploadGlob(logs, snap()));
    applyBatch(fixArtifactIfNoFilesFound(snap()));
    applyBatch(fixMultipleArtifactUploads(logs, snap()));
    applyBatch(fixGitLabArtifactConfig(snap()));
    applyBatch(fixArtifactCompression(logs, snap()));
    applyBatch(fixS3ArtifactFallback(logs, snap()));
    applyBatch(fixArtifactRetentionDays(snap()));
    applyBatch(fixArtifactNameMismatch(logs, snap()));
  }

  if (hasCategory('cache_restore_failure')) {
    applyBatch(fixCacheRestoreKeys(snap()));
    applyBatch(fixCachePathMismatch(logs, snap()));
    applyBatch(fixSetupActionBuiltinCache(snap()));
    applyBatch(fixGitLabCachePolicy(snap()));
    applyBatch(fixCacheKeyHashFiles(snap()));
    applyBatch(fixCacheBust(logs, snap()));
    applyBatch(fixCacheKeyOverSpecific(snap()));
    applyBatch(fixGitLabMissingCache(snap()));
  }

  if (hasCategory('parallel_sync_issue')) {
    applyBatch(fixBarrierGateJob(snap()));
    applyBatch(fixDownloadAfterUpload(snap()));
    applyBatch(fixParallelJobOutputPaths(snap()));
    applyBatch(fixMatrixArtifactFanIn(snap()));
    applyBatch(fixConcurrencyForPR(snap()));
    applyBatch(fixMatrixFanInSummary(snap()));
    applyBatch(fixWorkflowLevelEnvSharing(snap()));
    applyBatch(fixFailFastMatrix(snap()));
  }

  if (hasCategory('git_merge_conflict')) {
    applyBatch(fixMergeConflictMarkers(snap()));
    applyBatch(fixMergeUnrelatedHistories(logs, snap()));
    applyBatch(fixGitRebasePullStrategy(logs, snap()));
    applyBatch(fixBinaryMergeDriver(logs, snap()));
    applyBatch(fixStashBeforePull(logs, snap()));
    applyBatch(fixCherryPickAbort(logs, snap()));
    applyBatch(fixGitMergeStrategyFlag(logs, snap()));
    applyBatch(fixDivergentBranchConfig(logs, snap()));
    applyBatch(fixRebaseBeforeMerge(snap()));
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
    applyBatch(fixMissingPermissions(logs, snap()));
    applyBatch(fixInvalidBranchReference(logs, snap()));
    applyBatch(fixRejectedCommit(logs, snap()));
    applyBatch(fixNonFastForwardPush(logs, snap()));
    applyBatch(fixSSHAgentForPush(logs, snap()));
    applyBatch(fixGitPushFollowTags(logs, snap()));
    applyBatch(fixGitPushAtomic(logs, snap()));
    applyBatch(fixGitHubPagesDeploy(snap()));
    applyBatch(fixLargeFilePush(logs, snap()));
    applyBatch(fixGitMirrorPush(logs, snap()));
  }

  if (hasCategory('git_commit_rejected')) {
    applyBatch(fixRejectedCommit(logs, snap()));
    applyBatch(fixCommitMessageLint(logs, snap()));
    applyBatch(fixSignedCommitSetup(logs, snap()));
    applyBatch(fixDisableSigningInCI(logs, snap()));
    applyBatch(fixProtectedBranchPAT(logs, snap()));
    applyBatch(fixRecursivePipelineTrigger(snap()));
    applyBatch(fixPreReceiveSecretHook(logs, snap()));
    applyBatch(fixGitHubAppTokenGen(logs, snap()));
  }

  if (hasCategory('git_access_denied')) {
    applyBatch(fixGitRemoteWithToken(logs, snap()));
    applyBatch(fixSSHKnownHosts(logs, snap()));
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
    applyBatch(fixGitLabDefaultBranch(snap()));
    applyBatch(fixShallowClone(logs, snap()));
  }

  if (hasCategory('artifact_failure')) {
    applyBatch(fixArtifactNameMismatch(logs, snap()));
    applyBatch(fixArtifactOutputPath(logs, snap()));
    applyBatch(fixMissingOutputDirectory(logs, snap()));
  }

  if (hasCategory('cache_failure')) {
    applyBatch(fixCacheKeyOverSpecific(snap()));
    applyBatch(fixNpmCacheRestoreKeys(snap()));
  }

  if (hasCategory('runner_unavailable')) {
    applyBatch(fixParallelJobTimeouts(snap()));
    applyBatch(fixMissingRunner(logs, snap()));
    applyBatch(fixCircularDependency(logs, snap()));
  }

  if (hasCategory('deploy_failure')) {
    applyBatch(fixDeployRollbackOnFailure(snap()));
    applyBatch(fixSSHDeployNonBlocking(snap()));
    applyBatch(fixK8sRolloutWait(snap()));
    applyBatch(fixBlueGreenHealthCheck(logs, snap()));
    applyBatch(fixServiceUnavailable(logs, snap()));
    applyBatch(fixLoadBalancerRouting(logs, snap()));
    applyBatch(fixConnectionDraining(logs, snap()));
    applyBatch(fixCanaryDeployment(logs, snap()));
    // Extended rollback
    applyBatch(fixHelmRollbackOnFailure(logs, snap()));
    applyBatch(fixKubectlRollbackAnnotation(snap()));
    applyBatch(fixK8sRollbackHistoryLimit(snap()));
    applyBatch(fixHerokuReleaseRollback(logs, snap()));
    applyBatch(fixECSRollbackTaskDef(logs, snap()));
    applyBatch(fixCloudRunRollbackRevision(logs, snap()));
    applyBatch(fixAzureSlotRollback(logs, snap()));
    applyBatch(fixFlyioRollback(logs, snap()));
    applyBatch(fixGitLabDeployRollback(logs, snap()));
    applyBatch(fixDeployRollbackNotification(logs, snap()));
    // Production deploy gates
    applyBatch(fixConcurrentDeployPrevention(snap()));
    applyBatch(fixProdDeployBranchGuard(snap()));
    applyBatch(fixDeployTimeoutExtension(logs, snap()));
    applyBatch(fixPreDeploySmoke(logs, snap()));
  }

  if (hasCategory('rollback_failure')) {
    applyBatch(fixDeployRollbackOnFailure(snap()));
    applyBatch(fixHelmRollbackOnFailure(logs, snap()));
    applyBatch(fixKubectlRollbackAnnotation(snap()));
    applyBatch(fixK8sRollbackHistoryLimit(snap()));
    applyBatch(fixHerokuReleaseRollback(logs, snap()));
    applyBatch(fixECSRollbackTaskDef(logs, snap()));
    applyBatch(fixCloudRunRollbackRevision(logs, snap()));
    applyBatch(fixAzureSlotRollback(logs, snap()));
    applyBatch(fixFlyioRollback(logs, snap()));
    applyBatch(fixArgoRollbackSyncWave(snap()));
    applyBatch(fixTerraformDestroyGuard(logs, snap()));
    applyBatch(fixGitLabDeployRollback(logs, snap()));
    applyBatch(fixDeployRollbackNotification(logs, snap()));
  }

  if (hasCategory('failed_production_deploy')) {
    applyBatch(fixProdDeployGatingJob(snap()));
    applyBatch(fixConcurrentDeployPrevention(snap()));
    applyBatch(fixPreDeploySmoke(logs, snap()));
    applyBatch(fixDeployEnvValidation(logs, snap()));
    applyBatch(fixTerraformPlanBeforeApply(logs, snap()));
    applyBatch(fixHelmDryRunFirst(logs, snap()));
    applyBatch(fixK8sApplyValidation(logs, snap()));
    applyBatch(fixDeployTimeoutExtension(logs, snap()));
    applyBatch(fixDockerImageHealthProbe(snap()));
    applyBatch(fixProdDeployBranchGuard(snap()));
    applyBatch(fixDeployTaggedRelease(snap()));
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
    applyBatch(fixCanaryK8sReplicaCount(snap()));
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
    applyBatch(fixDockerStartupHealthcheck(snap()));
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
    applyBatch(fixYamlTabIndentation(snap()));
    applyBatch(fixDuplicateYamlKey(snap()));
    applyBatch(fixMissingYamlColon(logs, snap()));
    applyBatch(fixStepUsesAndRun(snap()));
    applyBatch(fixMissingWorkflowTrigger(snap()));
    applyBatch(fixWorkflowTriggerTypo(snap()));
    applyBatch(fixIncorrectConfigHierarchy(snap()));
    applyBatch(fixUnsupportedConfigParameter(logs, snap()));
    applyBatch(fixGitLabYamlAnchors(logs, snap()));
    applyBatch(fixDuplicateGitLabStage(snap()));
    applyBatch(fixDuplicateJobId(logs, snap()));
    applyBatch(fixDuplicateEnvKey(snap()));
  }

  if (hasCategory('invalid_gitlab_ci')) {
    applyBatch(fixGitLabYamlAnchors(logs, snap()));
    applyBatch(fixGitLabJobMissingImage(logs, snap()));
    applyBatch(fixGitLabExtendsMissing(logs, snap()));
    applyBatch(fixGitLabRulesNeverMatch(snap()));
    applyBatch(fixGitLabWorkflowRules(snap()));
    applyBatch(fixGitLabTriggerConfig(logs, snap()));
    applyBatch(fixGitLabParallelMatrix(logs, snap()));
    applyBatch(fixGitLabServicesConfig(logs, snap()));
    applyBatch(fixGitLabEnvironmentConfig(snap()));
    applyBatch(fixGitLabResourceGroup(snap()));
    applyBatch(fixGitLabStageOrder(snap()));
    applyBatch(fixGitLabStageOrdering(snap()));
    applyBatch(fixDuplicateGitLabStage(snap()));
    applyBatch(fixGitLabBeforeScriptLevel(logs, snap()));
    applyBatch(fixGitLabCECompatibility(logs, snap()));
    applyBatch(fixGitLabVariableScope(snap()));
    applyBatch(fixGitLabIncludePath(snap()));
  }

  if (hasCategory('invalid_workflow_syntax')) {
    applyBatch(fixInvalidJobId(logs, snap()));
    applyBatch(fixWorkflowExpressionSyntax(logs, snap()));
    applyBatch(fixWorkflowIfCondition(snap()));
    applyBatch(fixMissingStepsKey(logs, snap()));
    applyBatch(fixReusableWorkflowPin(snap()));
    applyBatch(fixMissingWorkflowName(snap()));
    applyBatch(fixActionInputTypeMismatch(logs, snap()));
    applyBatch(fixIfAlwaysSyntax(snap()));
    applyBatch(fixStepUsesAndRunConflict(snap()));
    applyBatch(fixDuplicateJobId(logs, snap()));
    applyBatch(fixDuplicatePermissions(snap()));
    applyBatch(fixIncorrectConfigHierarchy(snap()));
  }

  if (hasCategory('missing_config_file')) {
    applyBatch(fixMissingTsConfig(logs, snap()));
    applyBatch(fixMissingViteConfig(logs, snap()));
    applyBatch(fixMissingVitestConfig(logs, snap()));
    applyBatch(fixMissingNvmrc(logs, snap()));
    applyBatch(fixMissingPyprojectToml(logs, snap()));
    applyBatch(fixMissingDockerignore(snap()));
    applyBatch(fixMissingGitignore(logs, snap()));
    applyBatch(fixMissingPostcssConfig(logs, snap()));
    applyBatch(fixMissingBabelConfig(logs, snap()));
    applyBatch(fixMissingEslintConfig(logs, snap()));
    applyBatch(fixMissingJestConfig(logs, snap()));
    applyBatch(fixMissingPrettierConfig(logs, snap()));
    applyBatch(fixGitLabIncludePath(snap()));
  }

  if (hasCategory('config_hierarchy_error')) {
    applyBatch(fixIncorrectConfigHierarchy(snap()));
    applyBatch(fixTsConfigExtendsChain(logs, snap()));
    applyBatch(fixGitLabBeforeScriptLevel(logs, snap()));
    applyBatch(fixPackageJsonWorkspacesLevel(logs, snap()));
    applyBatch(fixStepUsesAndRunConflict(snap()));
  }

  if (hasCategory('unsupported_config_param')) {
    applyBatch(fixUnsupportedConfigParameter(logs, snap()));
    applyBatch(fixDeprecatedTsConfigOptions(logs, snap()));
    applyBatch(fixDockerComposeVersionField(snap()));
    applyBatch(fixIfAlwaysSyntax(snap()));
    applyBatch(fixGitLabCECompatibility(logs, snap()));
    applyBatch(fixNpmEnginesRange(logs, snap()));
  }

  if (hasCategory('duplicate_config_key')) {
    applyBatch(fixDuplicateJobId(logs, snap()));
    applyBatch(fixDuplicateGitLabStage(snap()));
    applyBatch(fixDuplicateEnvKey(snap()));
    applyBatch(fixDuplicateDockerPort(snap()));
    applyBatch(fixDuplicatePermissions(snap()));
    applyBatch(fixDuplicatePackageScript(snap()));
    applyBatch(fixDuplicateYamlKey(snap()));
  }

  if (hasCategory('env_mapping_error')) {
    applyBatch(fixEnvContextScope(snap()));
    applyBatch(fixGitLabVariableScope(snap()));
    applyBatch(fixSecretToEnvMapping(snap()));
    applyBatch(fixInputToEnvMapping(snap()));
    applyBatch(fixJobOutputDeclaration(snap()));
    applyBatch(fixTerraformVarEnv(logs, snap()));
    applyBatch(fixDotenvLoadOrder(logs, snap()));
    applyBatch(fixDockerComposeEnvFile(logs, snap()));
    applyBatch(fixK8sSecretEnvMapping(logs, snap()));
    applyBatch(fixMissingSecretsContext(snap()));
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
    applyBatch(fixNpmCiToInstall(snap()));
  }

  if (hasCategory('venv_missing')) {
    applyBatch(fixMissingVirtualEnv(logs, snap()));
    applyBatch(fixPipNoCacheDir(snap()));
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
    applyBatch(fixDockerComposePortFormat(snap()));
    applyBatch(fixDockerServiceContainerPorts(snap()));
  }

  if (hasCategory('image_pull_failure')) {
    applyBatch(fixDockerImagePullFailure(logs, snap()));
    applyBatch(fixDockerHubRateLimit(logs, snap()));
    applyBatch(fixDockerBaseImagePin(snap()));
    applyBatch(fixDockerImageDigestPin(snap()));
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
    applyBatch(fixServicePodDisruptionBudget(snap()));
    applyBatch(fixServiceHPAMinReplicas(snap()));
    applyBatch(fixServiceGracefulShutdown(logs, snap()));
    applyBatch(fixServiceTopologySpread(snap()));
    applyBatch(fixServiceCircuitBreaker(logs, snap()));
    applyBatch(fixServiceReadinessGate(snap()));
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
    applyBatch(fixSlackNotificationSecret(snap()));
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
    applyBatch(fixRESTBaseURLEnvVar(snap()));
    applyBatch(fixRESTVersionPrefix(logs, snap()));
    applyBatch(fixRESTMethodMismatch(logs, snap()));
    applyBatch(fixRESTTrailingSlash(logs, snap()));
    applyBatch(fixRESTAuthHeader(logs, snap()));
    applyBatch(fixRESTContentTypeHeader(logs, snap()));
    applyBatch(fixRESTEndpointEnvMatrix(snap()));
    applyBatch(fixRESTIdempotencyHeader(logs, snap()));
    applyBatch(fixRESTResponseTimeLogging(logs, snap()));
  }

  // ── NEW categories ────────────────────────────────────────────────────────

  if (hasCategory('husky_hook_failure')) {
    applyBatch(fixHuskyCI(snap()));
    applyBatch(fixHuskyPreCommitCI(snap()));
  }

  if (hasCategory('go_build_failure')) {
    applyBatch(fixGoModDownload(snap()));
    applyBatch(fixGitConfigSafeDirectory(logs, snap()));
  }

  if (hasCategory('rust_build_failure')) {
    applyBatch(fixRustCargoCache(snap()));
    applyBatch(fixRustCompilationError(logs, snap()));
    applyBatch(fixRustToolchainFile(snap()));
    applyBatch(fixCargoWorkspaceBuild(snap()));
    applyBatch(fixRustBinaryArtifact(snap()));
  }

  if (hasCategory('e2e_failure')) {
    applyBatch(fixPlaywrightBrowserInstall(snap()));
    applyBatch(fixCypressCIDependencies(snap()));
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
    applyBatch(fixTerraformEnvVars(snap()));
    applyBatch(fixMissingPermissions(logs, snap()));
  }

  if (hasCategory('matrix_failure')) {
    applyBatch(fixFailFastMatrix(snap()));
    applyBatch(fixParallelJobTimeouts(snap()));
    applyBatch(fixMissingRunner(logs, snap()));
  }

  if (hasCategory('artifact_retention')) {
    applyBatch(fixArtifactRetentionDays(snap()));
    applyBatch(fixArtifactNameMismatch(logs, snap()));
  }

  if (hasCategory('vite_build_failure')) {
    applyBatch(fixViteProductionBuild(snap()));
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
    applyBatch(fixDotnetRestore(snap()));
    applyBatch(fixDotNetCompilationError(logs, snap()));
    applyBatch(fixDotNetTargetFramework(logs, snap()));
    applyBatch(fixDotNetPublishArtifact(snap()));
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
  applyBatch(fixDockerBuildArgEnvVars(snap()));
  applyBatch(fixGoModDownload(snap()));
  applyBatch(fixRustCargoCache(snap()));
  applyBatch(fixESBuildPathResolution(logs, snap()));
  applyBatch(fixMakefileCIMode(snap()));

  // Intermediate cross-category
  applyBatch(fixShallowCloneFetchDepth(logs, snap()));
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
  applyBatch(fixMissingConcurrencyGroup(snap()));
  applyBatch(fixNullReferenceException(logs, snap()));
  applyBatch(fixTypeMismatch(logs, snap()));
  applyBatch(fixNodeHeapOOM(logs, snap()));
  applyBatch(fixUnhandledRejection(logs, snap()));
  applyBatch(fixUnitTestFailure(logs, snap()));
  applyBatch(fixIntegrationTestFailure(logs, snap()));
  applyBatch(fixTestEnvironmentMisconfig(logs, snap()));
  applyBatch(fixSubmoduleCheckout(logs, snap()));
  applyBatch(fixGitLFSCheckout(logs, snap()));
  applyBatch(fixGitUserConfig(logs, snap()));
  applyBatch(fixSSHKnownHosts(logs, snap()));
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
  applyBatch(fixPlaywrightBrowserInstall(snap()));
  applyBatch(fixCypressCIDependencies(snap()));
  applyBatch(fixMissingPrettierConfig(logs, snap()));
  applyBatch(fixESLintFlatConfig(logs, snap()));
  applyBatch(fixWebpackMemoryLimit(logs, snap()));
  applyBatch(fixDotnetRestore(snap()));
  applyBatch(fixViteProductionBuild(snap()));
  applyBatch(fixRubyBundlerSetup(snap()));
  applyBatch(fixAddDebugFlags(logs, snap()));
  // Pipeline cross-category
  applyBatch(fixShellStrictMode(logs, snap()));
  applyBatch(fixFlakyStageContinueOnError(logs, snap()));
  applyBatch(fixGitLabIncrementalPipeline(snap()));
  applyBatch(fixWorkflowRunWait(snap()));
  applyBatch(fixGitLabStageOrdering(snap()));
  applyBatch(fixGitLabDAGPipeline(snap()));
  applyBatch(fixSelfReferentialNeeds(logs, snap()));
  applyBatch(fixTwoJobCircularChain(logs, snap()));
  applyBatch(fixPushBranchFilter(snap()));
  applyBatch(fixCronScheduleExpression(logs, snap()));
  applyBatch(fixWorkflowCallContract(snap()));
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
  applyBatch(fixDownloadAfterUpload(snap()));
  applyBatch(fixParallelJobOutputPaths(snap()));
  applyBatch(fixMatrixArtifactFanIn(snap()));
  applyBatch(fixMatrixFanInSummary(snap()));
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
  applyBatch(fixMissingViteConfig(logs, snap()));
  applyBatch(fixMissingNvmrc(logs, snap()));
  applyBatch(fixMissingPyprojectToml(logs, snap()));
  applyBatch(fixMissingPostcssConfig(logs, snap()));
  applyBatch(fixMissingBabelConfig(logs, snap()));
  applyBatch(fixMissingGitignore(logs, snap()));
  applyBatch(fixTsConfigExtendsChain(logs, snap()));
  applyBatch(fixDeprecatedTsConfigOptions(logs, snap()));
  applyBatch(fixNpmEnginesRange(logs, snap()));
  applyBatch(fixDuplicateDockerPort(snap()));
  applyBatch(fixDuplicateGitLabStage(snap()));
  applyBatch(fixDuplicatePackageScript(snap()));
  applyBatch(fixInputToEnvMapping(snap()));
  applyBatch(fixJobOutputDeclaration(snap()));
  applyBatch(fixTerraformVarEnv(logs, snap()));
  applyBatch(fixDockerComposeEnvFile(logs, snap()));
  applyBatch(fixK8sSecretEnvMapping(logs, snap()));
  applyBatch(fixMissingAwsRegionMapping(logs, snap()));
  applyBatch(fixGitLabCECompatibility(logs, snap()));
  applyBatch(fixGitLabVariableScope(snap()));
  // Build fixers — cross-category
  applyBatch(fixGradleDaemonOOM(logs, snap()));
  applyBatch(fixMavenBuildScript(snap()));
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
  applyBatch(fixRustBinaryArtifact(snap()));
  applyBatch(fixDotNetPublishArtifact(snap()));
  applyBatch(fixGoArtifactPath(snap()));
  applyBatch(fixNextExportArtifact(snap()));
  applyBatch(fixDockerSaveArtifact(snap()));
  applyBatch(fixGradleTaskNotFound(logs, snap()));
  applyBatch(fixMavenGoalNotFound(logs, snap()));
  applyBatch(fixNpmWorkspaceScript(logs, snap()));
  applyBatch(fixTurboMissingTask(logs, snap()));
  applyBatch(fixBazelBuildTarget(logs, snap()));
  applyBatch(fixNodeExperimentalFlags(logs, snap()));
  applyBatch(fixPython2to3(snap()));
  applyBatch(fixJavaReleaseFlag(logs, snap()));
  applyBatch(fixDotNetTargetFramework(logs, snap()));
  applyBatch(fixGoModDirective(logs, snap()));
  applyBatch(fixAndroidGradleBuild(logs, snap()));
  // Extended build fixers — cross-category
  applyBatch(fixGraphQLCodegen(snap()));
  applyBatch(fixProtobufGenerate(snap()));
  applyBatch(fixCMakeBuildSetup(snap()));
  applyBatch(fixAngularBuildBudget(logs, snap()));
  applyBatch(fixPostCSSConfig(logs, snap()));
  applyBatch(fixNuxtNitroPreset(snap()));
  applyBatch(fixLambdaZipPackage(snap()));
  applyBatch(fixNuGetPackageOutput(snap()));
  applyBatch(fixHelmChartPackage(snap()));
  applyBatch(fixElectronArtifactPath(snap()));
  applyBatch(fixPythonWheelBuild(snap()));
  applyBatch(fixMixTask(logs, snap()));
  applyBatch(fixSbtBuildTask(logs, snap()));
  applyBatch(fixDockerComposeBuildService(snap()));
  applyBatch(fixOpenSSLLegacyProvider(snap()));
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
  applyBatch(fixKubectlRollbackAnnotation(snap()));
  applyBatch(fixK8sRollbackHistoryLimit(snap()));
  applyBatch(fixHerokuReleaseRollback(logs, snap()));
  applyBatch(fixECSRollbackTaskDef(logs, snap()));
  applyBatch(fixCloudRunRollbackRevision(logs, snap()));
  applyBatch(fixTerraformDestroyGuard(logs, snap()));
  applyBatch(fixGitLabDeployRollback(logs, snap()));
  applyBatch(fixDeployRollbackNotification(logs, snap()));
  applyBatch(fixAzureSlotRollback(logs, snap()));
  applyBatch(fixFlyioRollback(logs, snap()));
  applyBatch(fixArgoRollbackSyncWave(snap()));
  // Deployment cross-category — Section B (production deploy)
  applyBatch(fixProdDeployGatingJob(snap()));
  applyBatch(fixConcurrentDeployPrevention(snap()));
  applyBatch(fixPreDeploySmoke(logs, snap()));
  applyBatch(fixDeployEnvValidation(logs, snap()));
  applyBatch(fixTerraformPlanBeforeApply(logs, snap()));
  applyBatch(fixHelmDryRunFirst(logs, snap()));
  applyBatch(fixK8sApplyValidation(logs, snap()));
  applyBatch(fixDeployTimeoutExtension(logs, snap()));
  applyBatch(fixDockerImageHealthProbe(snap()));
  applyBatch(fixProdDeployBranchGuard(snap()));
  applyBatch(fixDeployTaggedRelease(snap()));
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
  applyBatch(fixCanaryK8sReplicaCount(snap()));
  applyBatch(fixCanaryMetricAnalysis(logs, snap()));
  applyBatch(fixCanaryRollbackThreshold(logs, snap()));
  applyBatch(fixCanaryCloudRunRevision(logs, snap()));
  applyBatch(fixCanaryECSTaskWeight(logs, snap()));
  applyBatch(fixCanaryProgressivePause(logs, snap()));
  applyBatch(fixCanaryFlaggerHPA(logs, snap()));
  applyBatch(fixCanaryHeaderRouting(logs, snap()));
  // Deployment cross-category — Section E (service availability)
  applyBatch(fixServiceStartupProbe(logs, snap()));
  applyBatch(fixServicePodDisruptionBudget(snap()));
  applyBatch(fixServiceHPAMinReplicas(snap()));
  applyBatch(fixServiceGracefulShutdown(logs, snap()));
  applyBatch(fixServiceTopologySpread(snap()));
  applyBatch(fixServiceCircuitBreaker(logs, snap()));
  applyBatch(fixServiceReadinessGate(snap()));
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
  applyBatch(fixGitLabDetachedHead(logs, snap()));
  // Docker cross-category — Section A (build)
  applyBatch(fixDockerBuildContextTooLarge(logs, snap()));
  applyBatch(fixDockerBuildArgMissing(logs, snap()));
  applyBatch(fixDockerMultiStageBuild(logs, snap()));
  applyBatch(fixDockerRUNLayerMerge(snap()));
  applyBatch(fixDockerAPTGetUpdate(snap()));
  applyBatch(fixDockerNPMInstallProd(snap()));
  applyBatch(fixDockerPipNoCacheDir(snap()));
  applyBatch(fixDockerCopyOrderForCache(snap()));
  applyBatch(fixDockerShellToExecForm(snap()));
  applyBatch(fixDockerBuildPlatformArg(logs, snap()));
  applyBatch(fixDockerQEMUSetup(logs, snap()));
  applyBatch(fixDockerLayerCleanup(snap()));
  // Docker cross-category — Section B (layer cache)
  applyBatch(fixDockerGHACacheMount(snap()));
  applyBatch(fixDockerRegistryLayerCache(snap()));
  applyBatch(fixDockerManifestUnknown(logs, snap()));
  applyBatch(fixDockerPullRetryOnBlob(logs, snap()));
  applyBatch(fixDockerBuildKitCacheMount(snap()));
  applyBatch(fixDockerSetupBuildx(snap()));
  applyBatch(fixDockerMetadataAction(snap()));
  applyBatch(fixDockerServicePullPolicy(snap()));
  // Docker cross-category — Section C (Dockerfile syntax)
  applyBatch(fixDockerfileHeredocSyntax(logs, snap()));
  applyBatch(fixDockerfileEnvVsArg(logs, snap()));
  applyBatch(fixDockerfileCmdEntrypointInteraction(snap()));
  applyBatch(fixDockerfileJSONArraySyntax(logs, snap()));
  applyBatch(fixDockerfileAddVsCopy(snap()));
  applyBatch(fixDockerfileWorkdirAbsolute(snap()));
  applyBatch(fixDockerfileLabelFormat(snap()));
  applyBatch(fixDockerfileNonRootUser(snap()));
  applyBatch(fixDockerignoreSecrets(snap()));
  applyBatch(fixDockerfileWildcardCopy(logs, snap()));
  // Docker cross-category — Section D (startup)
  applyBatch(fixDockerTiniInit(snap()));
  applyBatch(fixDockerEntrypointEnvCheck(snap()));
  applyBatch(fixDockerWaitForDependencies(logs, snap()));
  applyBatch(fixDockerStopSignal(snap()));
  applyBatch(fixDockerTimezone(snap()));
  applyBatch(fixDockerUlimits(logs, snap()));
  applyBatch(fixDockerResourceLimits(logs, snap()));
  applyBatch(fixDockerRestartPolicy(logs, snap()));
  applyBatch(fixDockerLoggingConfig(snap()));
  applyBatch(fixDockerStartupHealthcheck(snap()));
  // Docker cross-category — Section E (ports)
  applyBatch(fixDockerRandomPortAssignment(logs, snap()));
  applyBatch(fixDockerNetworkSubnetConflict(logs, snap()));
  applyBatch(fixDockerIPv6BindingConflict(logs, snap()));
  applyBatch(fixDockerComposePortFormat(snap()));
  applyBatch(fixDockerServiceContainerPorts(snap()));
  // Docker cross-category — Section F (registry auth)
  applyBatch(fixDockerGHCRLogin(logs, snap()));
  applyBatch(fixDockerECRLogin(logs, snap()));
  applyBatch(fixDockerACRLoginStep(logs, snap()));
  applyBatch(fixDockerGARLoginStep(logs, snap()));
  applyBatch(fixDockerHubAccessToken(logs, snap()));
  applyBatch(fixDockerPrivateRegistryCA(logs, snap()));
  applyBatch(fixDockerCredentialHelper(snap()));
  // Docker cross-category — Section G (image pull)
  applyBatch(fixDockerImageDigestPin(snap()));
  applyBatch(fixDockerRegistryPathFormat(logs, snap()));
  applyBatch(fixDockerTagFallback(logs, snap()));
  applyBatch(fixDockerComposePrivateImageAuth(logs, snap()));
  applyBatch(fixDockerAlpineApkMirror(logs, snap()));
  applyBatch(fixDockerTrivyScanStep(snap()));
  applyBatch(fixDockerPullPlatformMismatch(logs, snap()));
  // Docker cross-category — Section H (volumes)
  applyBatch(fixDockerNamedVolumes(snap()));
  applyBatch(fixDockerVolumeSelinuxLabel(logs, snap()));
  applyBatch(fixDockerBindMountAbsolutePath(logs, snap()));
  applyBatch(fixDockerVolumeReadOnly(snap()));
  applyBatch(fixDockerTmpfsMount(logs, snap()));
  applyBatch(fixDockerNFSVolumeOptions(logs, snap()));
  applyBatch(fixDockerVolumeDriverConfig(logs, snap()));
  applyBatch(fixDockerComposeInit(snap()));
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
  applyBatch(fixRESTBaseURLEnvVar(snap()));
  applyBatch(fixRESTVersionPrefix(logs, snap()));
  applyBatch(fixRESTMethodMismatch(logs, snap()));
  applyBatch(fixRESTTrailingSlash(logs, snap()));
  applyBatch(fixRESTAuthHeader(logs, snap()));
  applyBatch(fixRESTContentTypeHeader(logs, snap()));
  applyBatch(fixRESTEndpointEnvMatrix(snap()));
  applyBatch(fixRESTIdempotencyHeader(logs, snap()));
  applyBatch(fixRESTResponseTimeLogging(logs, snap()));
  // Runtime cross-category
  applyBatch(fixNullDerefOptionalChain(logs, snap()));
  applyBatch(fixPythonNoneCheck(logs, snap()));
  applyBatch(fixGoNilPointerDeref(logs, snap()));
  applyBatch(fixRustUnwrapToExpect(logs, snap()));
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
  applyBatch(fixNodeEventListenerLeak(logs, snap()));
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
  applyBatch(fixExpressErrorMiddleware(logs, snap()));
  applyBatch(fixPromiseAllSettled(logs, snap()));
  applyBatch(fixPythonExceptionLogging(logs, snap()));
  applyBatch(fixJavaUncaughtExceptionHandler(logs, snap()));
  applyBatch(fixDotNetUnhandledException(logs, snap()));
  applyBatch(fixSentryRuntimeCapture(logs, snap()));
  applyBatch(fixBrowserGlobalErrorHandler(logs, snap()));
  applyBatch(fixRuntimeExceptionDiagnostics(logs, snap()));

  // Build output — one RuleFix per modified file
  return [...explanations.entries()].map(([path, exps]) => ({
    path,
    content: working.get(path)!,
    explanation: exps.join('; '),
    confidence: 100,
  }));
}
