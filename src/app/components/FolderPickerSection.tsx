import { useRef } from 'react';
import { motion } from 'motion/react';
import { FolderOpen } from 'lucide-react';
import { SelectedFile } from '../types';

// Directory segments that are always skipped — matches standard .gitignore patterns
const IGNORED_DIRS = new Set([
  '.venv', 'venv', '.env', 'env',
  'node_modules',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.git',
  'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'target',        // Rust/Java
  '.gradle',       // Gradle
  'vendor',        // Go/PHP
  '.DS_Store',
]);

function isIgnored(relativePath: string): boolean {
  // Ignore if any path segment matches a known junk directory
  return relativePath.split('/').some(seg => IGNORED_DIRS.has(seg));
}

interface FolderPickerSectionProps {
  selectedFiles: SelectedFile[];
  folderName: string;
  skippedCount: number;
  onFilesSelected: (files: SelectedFile[], folderName: string, skipped: number) => void;
}

export function FolderPickerSection({ selectedFiles, folderName, skippedCount, onFilesSelected }: FolderPickerSectionProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;

    const firstPath = files[0].webkitRelativePath || files[0].name;
    const rootFolder = firstPath.split('/')[0];

    const mapped = files.map(f => {
      const parts = (f.webkitRelativePath || f.name).split('/');
      const relativePath = parts.length > 1 ? parts.slice(1).join('/') : f.name;
      return { file: f, relativePath };
    });

    const selected = mapped.filter(f => f.relativePath && !isIgnored(f.relativePath));
    const skipped = mapped.length - selected.length;

    onFilesSelected(selected, rootFolder, skipped);
  };

  return (
    <div className="mb-8">
      <div className="font-mono text-[10px] text-[#9A8678] tracking-widest mb-3">SELECT_FILES</div>

      {/* Hidden native file input — triggered by the styled button below */}
      <input
        ref={fileInputRef}
        type="file"
        // @ts-ignore — webkitdirectory is not in React's types but works in all browsers
        webkitdirectory=""
        multiple
        className="hidden"
        onChange={handleChange}
      />

      {/* Styled folder picker button */}
      <motion.button
        onClick={() => fileInputRef.current?.click()}
        className="w-full border border-dashed border-[#CAAA98]/30 bg-[#0a0e1a]/40 p-8 flex flex-col items-center gap-3 hover:border-[#CAAA98]/60 hover:bg-[#0a0e1a]/60 transition-all"
        whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
      >
        <FolderOpen className="w-8 h-8 text-[#9A8678]/40" strokeWidth={1} />
        {selectedFiles.length === 0 ? (
          <>
            <div className="font-mono text-sm text-[#CAAA98]">CHOOSE_FOLDER</div>
            <div className="font-mono text-[9px] text-[#9A8678]/40">click to select a folder</div>
          </>
        ) : (
          <>
            <div className="font-mono text-sm text-[#CAAA98]">{folderName}/</div>
            <div className="font-mono text-[9px] text-[#6A9A7A]">{selectedFiles.length} files ready</div>
            {skippedCount > 0 && (
              <div className="font-mono text-[9px] text-[#D4A574]/70">{skippedCount} ignored (venv / node_modules / etc.)</div>
            )}
          </>
        )}
      </motion.button>

      {/* Preview list of selected files */}
      {selectedFiles.length > 0 && (
        <div className="mt-3 border border-[#CAAA98]/10 bg-[#0a0e1a]/30 p-3 max-h-36 overflow-y-auto">
          {selectedFiles.slice(0, 10).map(f => (
            <div key={f.relativePath} className="font-mono text-[10px] text-[#9A8678]/60 py-0.5">
              <span className="text-[#9A8678]/25">│</span> {f.relativePath}
            </div>
          ))}
          {selectedFiles.length > 10 && (
            <div className="font-mono text-[10px] text-[#9A8678]/40 py-0.5 pl-3">
              ... and {selectedFiles.length - 10} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}
