/**
 * Proposal Apply/Reject Engine for DOREA-X Editor
 *
 * Risk Tiers:
 * - 'auto'    : Bounded, safe operations (e.g., insert at cursor) — can auto-apply
 * - 'preview' : Default — shows preview, requires single click accept
 * - 'confirm' : Destructive/global operations (e.g., replace all, clear) — requires explicit confirm dialog
 *
 * Revision Conflict Detection:
 * - Each proposal stores a `revision_hash` of the editor content at proposal time
 * - At apply time, current editor revision hash is compared
 * - Mismatch → block apply, offer regenerate
 */

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Smart section replacement: detect heading in proposal, find matching section
 * in current markdown, and replace only that section.
 *
 * @param {string} proposalContent - The new content (may start with a heading)
 * @param {string} currentMarkdown - Current editor content
 * @returns {{ type: 'section'|'full'|'append', content: string }}
 */
export function smartSectionReplace(proposalContent, currentMarkdown) {
  if (!currentMarkdown || !currentMarkdown.trim()) {
    // Editor is empty — just set content
    return { type: 'full', content: proposalContent }
  }

  // Extract first heading from proposal content
  const headingMatch = proposalContent.match(/^(#{1,6})\s+(.+)$/m)
  if (!headingMatch) {
    // No heading in proposal — full replace
    return { type: 'full', content: proposalContent }
  }

  const headingLevel = headingMatch[1].length
  const headingText = headingMatch[2].trim()

  // Find matching heading in current markdown (case-insensitive, trimmed)
  const lines = currentMarkdown.split('\n')
  let sectionStart = -1
  let sectionEnd = -1

  for (let i = 0; i < lines.length; i++) {
    const lineMatch = lines[i].match(/^(#{1,6})\s+(.+)$/)
    if (!lineMatch) continue

    const lineLevel = lineMatch[1].length
    const lineText = lineMatch[2].trim()

    if (sectionStart === -1) {
      // Looking for the matching heading
      if (lineLevel === headingLevel && lineText === headingText) {
        sectionStart = i
      }
    } else {
      // Found start, looking for end: next heading at same or higher level
      if (lineLevel <= headingLevel) {
        sectionEnd = i
        break
      }
    }
  }

  if (sectionStart === -1) {
    // Heading not found in current content — append at end
    return { type: 'append', content: proposalContent }
  }

  // If no next heading found, section extends to end of document
  if (sectionEnd === -1) {
    sectionEnd = lines.length
  }

  // Build new content: before + proposal + after
  const before = lines.slice(0, sectionStart).join('\n')
  const after = lines.slice(sectionEnd).join('\n')

  let newContent = ''
  if (before.trim()) {
    newContent += before + '\n\n'
  }
  newContent += proposalContent
  if (after.trim()) {
    newContent += '\n\n' + after
  }

  return { type: 'section', content: newContent.trim() }
}

/**
 * Check if proposal's revision hash matches current editor state
 * @param {Object} proposal - Proposal with revision_hash field
 * @param {Object} editorRef - React ref to ToastEditor imperative bridge
 * @returns {{ ok: boolean, currentHash: string, proposalHash: string }}
 */
export function checkRevisionConflict(proposal, editorRef) {
  if (!editorRef?.current) {
    return { ok: false, currentHash: null, proposalHash: proposal.revision_hash, reason: 'editor_unavailable' }
  }

  const currentHash = editorRef.current.getRevisionHash()
  const proposalHash = proposal.revision_hash

  // If proposal has no revision hash, skip conflict check (backward compat)
  if (!proposalHash) {
    return { ok: true, currentHash, proposalHash: null, reason: null }
  }

  if (currentHash !== proposalHash) {
    return {
      ok: false,
      currentHash,
      proposalHash,
      reason: 'revision_mismatch',
    }
  }

  return { ok: true, currentHash, proposalHash, reason: null }
}

/**
 * Determine if a proposal requires confirmation based on risk tier
 * @param {Object} proposal
 * @returns {'auto' | 'preview' | 'confirm'}
 */
export function getEffectiveRiskTier(proposal) {
  const tier = proposal.risk_tier || 'preview'

  // Force 'confirm' for destructive commands regardless of declared tier
  const destructiveCommands = new Set(['replace_all', 'clear', 'delete_all', 'reset'])
  if (destructiveCommands.has(proposal.command)) {
    return 'confirm'
  }

  // Force at least 'preview' for full-document rewrites
  if (proposal.command === 'rewrite' && tier === 'auto') {
    return 'preview'
  }

  return tier
}

/**
 * Apply a proposal to the editor
 * @param {Object} proposal - The proposal to apply
 * @param {Object} editorRef - React ref to ToastEditor imperative bridge
 * @returns {{ success: boolean, error?: string }}
 */
export function applyProposal(proposal, editorRef) {
  if (!editorRef?.current) {
    return { success: false, error: 'Editor is not available' }
  }

  const editor = editorRef.current
  const command = proposal.command || 'insert'
  const content = proposal.content || ''

  try {
    switch (command) {
      case 'insert':
      case 'insert_text': {
        // In WYSIWYG mode, insertText inserts plain text without markdown rendering.
        // Instead, append markdown content and re-set via setMarkdown so it renders properly.
        const currentMd = editor.getMarkdown()
        const separator = currentMd.trim() ? '\n\n' : ''
        editor.setMarkdown(currentMd + separator + content)
        break
      }

      case 'rewrite': {
        // Smart section replacement: if proposal content starts with a heading
        // and the editor contains that heading, replace only that section.
        const currentMarkdown = editor.getMarkdown()
        const result = smartSectionReplace(content, currentMarkdown)
        editor.setMarkdown(result.content)
        break
      }

      case 'replace':
      case 'replace_selection': {
        // For selection-based replacement in WYSIWYG, use the underlying API.
        // If no selection target, fall back to full markdown replacement with content appended.
        if (proposal.target?.start && proposal.target?.end) {
          editor.replaceSelection(content, proposal.target.start, proposal.target.end)
        } else {
          // No specific target — replace selection or append via markdown
          const sel = editor.getSelection()
          if (sel) {
            editor.replaceSelection(content)
          } else {
            const curMd = editor.getMarkdown()
            const sep = curMd.trim() ? '\n\n' : ''
            editor.setMarkdown(curMd + sep + content)
          }
        }
        break
      }

      case 'style':
        // Execute editor command (bold, italic, heading, etc.)
        if (proposal.metadata?.exec_command) {
          editor.exec(proposal.metadata.exec_command)
        } else {
          // Fallback: replace selection with styled content
          editor.replaceSelection(content)
        }
        break

      default: {
        // Unknown command — append via markdown for proper WYSIWYG rendering
        const fallbackMd = editor.getMarkdown()
        const fallbackSep = fallbackMd.trim() ? '\n\n' : ''
        editor.setMarkdown(fallbackMd + fallbackSep + content)
        break
      }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || 'Apply failed' }
  }
}

/**
 * Full apply flow with conflict check and risk tier enforcement
 * @param {Object} params
 * @param {Object} params.proposal
 * @param {Object} params.editorRef
 * @param {Function} params.onConflict - Called when revision mismatch detected
 * @param {Function} params.onConfirmRequired - Called when 'confirm' tier needs explicit dialog
 * @param {Function} params.onSuccess - Called after successful apply
 * @param {Function} params.onError - Called on failure
 */
export function handleProposalApply({ proposal, editorRef, onConflict, onConfirmRequired, onSuccess, onError }) {
  // Step 1: Revision conflict check
  const conflict = checkRevisionConflict(proposal, editorRef)
  if (!conflict.ok) {
    if (conflict.reason === 'revision_mismatch') {
      onConflict?.({
        proposal,
        currentHash: conflict.currentHash,
        proposalHash: conflict.proposalHash,
        message: '문서가 제안 이후 변경되었습니다. 다시 생성하거나 강제 적용해주세요.',
      })
      return
    }
    onError?.({ proposal, message: 'Editor not available' })
    return
  }

  // Step 2: Risk tier check
  const effectiveTier = getEffectiveRiskTier(proposal)
  if (effectiveTier === 'confirm') {
    onConfirmRequired?.({
      proposal,
      message: `이 작업(${proposal.command})은 문서에 큰 영향을 줄 수 있습니다. 계속하시겠습니까?`,
      onConfirm: () => {
        const result = applyProposal(proposal, editorRef)
        if (result.success) {
          onSuccess?.(proposal)
        } else {
          onError?.({ proposal, message: result.error })
        }
      },
    })
    return
  }

  // Step 3: Apply (auto or preview-accepted)
  const result = applyProposal(proposal, editorRef)
  if (result.success) {
    onSuccess?.(proposal)
  } else {
    onError?.({ proposal, message: result.error })
  }
}
