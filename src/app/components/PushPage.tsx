import { useState, useRef } from 'react';
import { FolderPickerSection } from './FolderPickerSection';
import { PushConfigForm } from './PushConfigForm';
import { PushLogStream } from './PushLogStream';
import { SelectedFile, PushLogEntry } from '../types';
import {
  createGithubRepo, checkRepoExists, getDefaultBranchSha,
  createBranchFromSha, getFileSha, pushFile, fileToBase64, parseRepoInput,
} from '../lib/githubPush';

interface PushPageProps {
  githubPat: string;
}

type Mode = 'existing' | 'new';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB — GitHub Contents API per-file limit

export function PushPage({ githubPat }: PushPageProps) {
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [folderName, setFolderName] = useState('');
  const [mode, setMode] = useState<Mode>('existing');
  const [repoInput, setRepoInput] = useState('');
  const [newRepoName, setNewRepoName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [branch, setBranch] = useState('main');
  const [commitMsg, setCommitMsg] = useState('');
  const [pushing, setPushing] = useState(false);
  const [logs, setLogs] = useState<PushLogEntry[]>([]);
  const [pushComplete, setPushComplete] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [skippedCount, setSkippedCount] = useState(0);

  const logIdRef = useRef(0);
  const addLog = (type: PushLogEntry['type'], message: string) =>
    setLogs(prev => [...prev, { id: String(++logIdRef.current), type, message }]);

  const handleFilesSelected = (files: SelectedFile[], folder: string, skipped: number) => {
    setFolderName(folder);
    setSelectedFiles(files);
    setSkippedCount(skipped);
    setLogs([]);
    setPushComplete(false);
    setRepoUrl('');
  };

  const push = async () => {
    if (!githubPat || !selectedFiles.length) return;

    setPushing(true);
    setPushComplete(false);
    setLogs([]);
    setRepoUrl('');

    try {
      let owner: string;
      let repo: string;
      let targetBranch: string | undefined;

      if (mode === 'new') {
        const name = newRepoName.trim();
        if (!name) { addLog('error', 'repo name is required'); setPushing(false); return; }

        addLog('info', `creating_repo :: ${name} (${isPrivate ? 'private' : 'public'})`);
        const created = await createGithubRepo(githubPat, name, isPrivate);
        if (!created) { addLog('error', 'repo_creation_failed :: check token permissions'); setPushing(false); return; }

        owner = created.owner;
        repo = created.repo;
        targetBranch = undefined; // GitHub creates `main` automatically on first push
        addLog('success', `repo_created :: github.com/${owner}/${repo}`);

      } else {
        const parsed = parseRepoInput(repoInput);
        if (!parsed) { addLog('error', 'invalid_repo :: use owner/repo format'); setPushing(false); return; }

        owner = parsed.owner;
        repo = parsed.repo;

        addLog('info', `verifying_repo :: ${owner}/${repo}`);
        const exists = await checkRepoExists(githubPat, owner, repo);
        if (!exists) { addLog('error', `repo_not_found :: github.com/${owner}/${repo}`); setPushing(false); return; }
        addLog('success', `repo_verified :: ${owner}/${repo}`);

        const branchName = branch.trim() || 'main';
        const defaultInfo = await getDefaultBranchSha(githubPat, owner, repo);

        if (defaultInfo && branchName !== defaultInfo.branch) {
          addLog('info', `creating_branch :: ${branchName} from ${defaultInfo.branch}`);
          const created = await createBranchFromSha(githubPat, owner, repo, branchName, defaultInfo.sha);
          addLog(created ? 'success' : 'info', created ? `branch_created :: ${branchName}` : `branch_exists :: ${branchName} (using existing)`);
        }

        targetBranch = branchName;
      }

      // Filter out files that exceed GitHub's 1MB limit
      const validFiles = selectedFiles.filter(f => {
        if (f.file.size > MAX_FILE_SIZE) {
          addLog('error', `skipped :: ${f.relativePath} (exceeds 1MB limit)`);
          return false;
        }
        return true;
      });

      addLog('info', `pushing ${validFiles.length} files to ${owner}/${repo}`);

      let pushed = 0;
      let failed = 0;
      const message = commitMsg.trim() || 'add: files uploaded via aegis';

      for (const { file, relativePath } of validFiles) {
        try {
          const base64 = await fileToBase64(file);

          // For updates, we need the existing file's SHA to avoid a 422 error
          let existingSha: string | undefined;
          if (targetBranch) {
            const sha = await getFileSha(githubPat, owner, repo, relativePath, targetBranch);
            if (sha) existingSha = sha;
          }

          const ok = await pushFile(githubPat, owner, repo, relativePath, base64, message, targetBranch, existingSha);

          if (ok) { addLog('success', `pushed :: ${relativePath}`); pushed++; }
          else { addLog('error', `failed :: ${relativePath}`); failed++; }
        } catch {
          addLog('error', `error :: ${relativePath}`);
          failed++;
        }
      }

      const finalUrl = `https://github.com/${owner}/${repo}/tree/${targetBranch ?? 'main'}`;
      setRepoUrl(finalUrl);

      if (pushed > 0) {
        addLog('success', `complete :: ${pushed} pushed${failed > 0 ? `, ${failed} failed` : ''}`);
        setPushComplete(true);
      } else {
        addLog('error', 'all_pushes_failed :: 0 files pushed');
      }

    } catch (err) {
      addLog('error', `error :: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    setPushing(false);
  };

  const canPush = !pushing && !!githubPat && selectedFiles.length > 0 &&
    (mode === 'new' ? !!newRepoName.trim() : !!repoInput.trim());

  return (
    <div className="flex-1 flex overflow-hidden">

      {/* Left panel: folder picker + config form */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-lg">
          <FolderPickerSection
            selectedFiles={selectedFiles}
            folderName={folderName}
            skippedCount={skippedCount}
            onFilesSelected={handleFilesSelected}
          />
          <PushConfigForm
            githubPat={githubPat}
            mode={mode}
            repoInput={repoInput}
            newRepoName={newRepoName}
            isPrivate={isPrivate}
            branch={branch}
            commitMsg={commitMsg}
            pushing={pushing}
            canPush={canPush}
            pushComplete={pushComplete}
            repoUrl={repoUrl}
            onModeChange={setMode}
            onRepoInputChange={setRepoInput}
            onNewRepoNameChange={setNewRepoName}
            onIsPrivateChange={setIsPrivate}
            onBranchChange={setBranch}
            onCommitMsgChange={setCommitMsg}
            onPush={push}
          />
        </div>
      </div>

      {/* Right panel: live log stream (slides in once logs appear) */}
      <PushLogStream logs={logs} pushing={pushing} />
    </div>
  );
}
