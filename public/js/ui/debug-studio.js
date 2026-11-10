export function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[m]));
}

export function fmtSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const SEC_COLORS = {
  intro: 'rgba(255, 184, 0, 0.25)',
  verse: 'rgba(245, 245, 240, 0.08)',
  build: 'rgba(255, 130, 0, 0.28)',
  chorus: 'rgba(255, 77, 0, 0.34)',
  drop: 'rgba(255, 77, 0, 0.38)',
  bridge: 'rgba(130, 170, 255, 0.22)',
  outro: 'rgba(255, 184, 0, 0.2)',
};

function renderSongGridSvg(analysis, mixOutBar = null, mixInBar = null) {
  const dur = Math.max(1, analysis.duration_sec || 180);
  const heat = analysis.heat || [];
  const W = 800;
  const H = 96;

  // Sections background
  const secRects = (analysis.sections || []).map((s) => {
    const x = Math.max(0, ((s.start_sec || 0) / dur) * W);
    const w = Math.max(2, (((s.end_sec || dur) - (s.start_sec || 0)) / dur) * W);
    const fill = SEC_COLORS[s.type] || 'rgba(245,245,240,0.06)';
    return `<g>
      <rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="18" fill="${fill}" />
      ${w > 34 ? `<text x="${(x + 4).toFixed(1)}" y="13" fill="rgba(245,245,240,0.75)" font-size="9" font-family="monospace">${escHtml(s.type.toUpperCase())}</text>` : ''}
    </g>`;
  }).join('');

  // Instrumental gaps band at bottom
  const gapRects = (analysis.instrumental_gaps || []).map((g) => {
    const x = Math.max(0, ((g.start_sec || 0) / dur) * W);
    const w = Math.max(2, (((g.end_sec || 0) - (g.start_sec || 0)) / dur) * W);
    return `<rect x="${x.toFixed(1)}" y="${H - 6}" width="${w.toFixed(1)}" height="5" fill="#ffb800" opacity="0.7" />`;
  }).join('');

  // 88 waveform bars
  const bars = heat.map((h, i) => {
    const x = (i / Math.max(1, heat.length)) * W;
    const bh = Math.max(3, h * 54);
    const y = 22 + (58 - bh) / 2;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(W / heat.length * 0.7).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="rgba(245,245,240,0.52)" />`;
  }).join('');

  // Downbeats (subsample max 48 lines to keep SVG fast)
  const dbs = analysis.downbeat_times || [];
  const step = Math.max(1, Math.floor(dbs.length / 48));
  const dbLines = dbs.filter((_, idx) => idx % step === 0).map((t) => {
    const x = (t / dur) * W;
    return `<line x1="${x.toFixed(1)}" y1="20" x2="${x.toFixed(1)}" y2="${H - 8}" stroke="rgba(255,77,0,0.45)" stroke-width="1" />`;
  }).join('');

  // Mix markers
  let markerSvg = '';
  if (mixOutBar !== null && analysis.bars?.[mixOutBar]) {
    const x = (analysis.bars[mixOutBar].start_sec / dur) * W;
    markerSvg += `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}" stroke="#ff4d00" stroke-width="2.5" />
      <text x="${Math.min(W - 55, x + 3).toFixed(1)}" y="${H - 12}" fill="#ff4d00" font-size="10" font-weight="bold" font-family="monospace">OUT B${mixOutBar}</text>`;
  }
  if (mixInBar !== null && analysis.bars?.[mixInBar]) {
    const x = (analysis.bars[mixInBar].start_sec / dur) * W;
    markerSvg += `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${H}" stroke="#ffb800" stroke-width="2.5" />
      <text x="${Math.min(W - 55, x + 3).toFixed(1)}" y="30" fill="#ffb800" font-size="10" font-weight="bold" font-family="monospace">IN B${mixInBar}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:76px;display:block;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(245,245,240,0.1)">
    ${secRects}${bars}${dbLines}${gapRects}${markerSvg}
  </svg>`;
}

export function renderDebugModal({ plan, tracks, opusBusy, exportBusy, exportMsg, previewBusyIdx, ratingsMap }) {
  const analyses = plan?.analyses || [];
  const transitions = plan?.transitions || [];
  const dspCount = tracks.filter((t) => t.file || t.dspReady).length;

  return `
    <div class="modal-backdrop" id="debug-backdrop">
      <div class="modal-sheet" style="max-width:64rem;max-height:92dvh" onclick="event.stopPropagation()">
        <div style="padding:20px 24px;display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;border-bottom:2px solid rgba(245,245,240,0.12)">
          <div>
            <div class="font-display text-accent" style="font-size:30px;line-height:1">BEAT GRID &amp; RECIPE STUDIO</div>
            <div style="font-size:13px;color:rgba(245,245,240,0.6)">
              Planner: <strong class="text-amber">${escHtml(plan?.plannerSource || 'NOVA Engine')}</strong>
              · Validator: <strong style="color:${plan?.validation?.valid ? '#6bff95' : '#ffb800'}">${plan?.validation?.valid ? 'ALL RULES PASSED ✓' : 'SAFE FALLBACK ACTIVE'}</strong>
              ${opusBusy ? ' · Querying Claude Opus…' : ''}
            </div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button id="btn-export-wav-debug" class="pill-btn squeeze" style="border-color:var(--amber);color:var(--amber)" ${exportBusy || !dspCount ? 'disabled' : ''}>
              ${exportBusy ? 'RENDERING .WAV…' : '⬇ EXPORT MIX (.WAV)'}
            </button>
            <button id="btn-close-debug" class="exit-btn">✕</button>
          </div>
        </div>

        <div class="nova-scroll" style="padding:18px 24px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:22px">
          ${exportMsg ? `<div class="status-banner" style="padding:8px 12px;border:1px solid rgba(255,184,0,0.3);border-radius:10px">${escHtml(exportMsg)}</div>` : ''}

          <div>
            <div class="font-display" style="font-size:22px;color:rgba(245,245,240,0.7);margin-bottom:10px">TRANSITION RECIPES &amp; COMPATIBILITY SCORES (${transitions.length})</div>
            <div style="display:flex;flex-direction:column;gap:14px">
              ${transitions.length ? transitions.map((rec, idx) => {
                const a = analyses.find((x) => x.song_id === rec.from) || {};
                const b = analyses.find((x) => x.song_id === rec.to) || {};
                const bd = rec.compatibility?.breakdown || {};
                const scorePct = Math.round((rec.compatibility?.score || 0.7) * 100);
                const rKey = `${rec.from}->${rec.to}`;
                const rated = ratingsMap[rKey];
                const isPrevBusy = previewBusyIdx === idx;
                const riskCol = rec.risk === 'high' ? '#ff6b6b' : rec.risk === 'medium' ? 'var(--amber)' : '#6bff95';
                const canPreview = Boolean(a.isDsp && b.isDsp);

                return `
                  <div style="border:2px solid rgba(245,245,240,0.14);border-radius:18px;padding:16px;background:rgba(255,255,255,0.02)">
                    <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px;align-items:center">
                      <div>
                        <span class="font-mono-num" style="font-size:12px;color:var(--accent)">#${idx + 1}</span>
                        <strong style="font-size:17px">${escHtml(a.title || rec.from)}</strong>
                        <span style="color:var(--amber)"> → </span>
                        <strong style="font-size:17px">${escHtml(b.title || rec.to)}</strong>
                      </div>
                      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                        <span class="row-tag">${escHtml(String(rec.type || '').replace(/_/g, ' ').toUpperCase())}</span>
                        <span class="font-mono-num" style="font-size:12px;padding:2px 8px;border-radius:6px;background:rgba(255,77,0,0.14);color:var(--accent)">SCORE ${scorePct}%</span>
                        <span class="font-mono-num" style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid ${riskCol};color:${riskCol}">RISK ${escHtml(String(rec.risk || 'low').toUpperCase())}</span>
                      </div>
                    </div>

                    <div class="font-mono-num" style="font-size:11px;color:rgba(245,245,240,0.58);margin-top:8px;display:flex;flex-wrap:wrap;gap:10px">
                      <span>OUT: Bar ${rec.mix_out_bar}</span>
                      <span>IN: Bar ${rec.mix_in_bar}</span>
                      <span>LEN: ${rec.length_bars} Bars</span>
                      <span>STRETCH: ${rec.tempo_plan?.stretch_from || '?'}→${rec.tempo_plan?.stretch_to || '?'} BPM (${rec.tempo_plan?.pitch_shift_semitones >= 0 ? '+' : ''}${rec.tempo_plan?.pitch_shift_semitones || 0}st)</span>
                      ${rec.added_drums ? `<span style="color:var(--amber)">+ DRUMS: ${escHtml(rec.added_drums.style.toUpperCase())}</span>` : ''}
                      <span>T:${bd.T ?? '-'} K:${bd.K ?? '-'} E:${bd.E ?? '-'} P:${bd.P ?? '-'} V:${bd.V ?? '-'} G:${bd.G ?? '-'}</span>
                    </div>

                    <p style="margin-top:8px;font-size:13px;color:rgba(245,245,240,0.78);line-height:1.45">${escHtml(rec.why)}</p>

                    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
                      ${canPreview ? `<button class="pill-btn squeeze" style="font-size:14px;padding:5px 12px" data-preview-rec="${idx}" ${isPrevBusy ? 'disabled' : ''}>${isPrevBusy ? 'PLAYING PREVIEW…' : '▶ PREVIEW 8S'}</button>` : ''}
                      <button class="pill-btn squeeze" style="font-size:14px;padding:5px 12px" data-regen-rec="${idx}">↻ REGENERATE</button>
                      <button class="pill-btn squeeze ${rated === 'good' ? 'active' : ''}" style="font-size:14px;padding:5px 12px" data-rate-rec="${idx}" data-rate-val="good">👍 GOOD</button>
                      <button class="pill-btn squeeze ${rated === 'bad' ? 'active' : ''}" style="font-size:14px;padding:5px 12px" data-rate-rec="${idx}" data-rate-val="bad">👎 FIX</button>
                    </div>
                  </div>
                `;
              }).join('') : '<p style="color:rgba(245,245,240,0.5)">Add at least 2 tracks to inspect transitions.</p>'}
            </div>
          </div>

          <div>
            <div class="font-display" style="font-size:22px;color:rgba(245,245,240,0.7);margin-bottom:10px">TRACK BEAT GRIDS, SECTIONS &amp; INSTRUMENTAL GAPS (${analyses.length})</div>
            <div style="display:flex;flex-direction:column;gap:14px">
              ${analyses.map((a, idx) => {
                const outRec = transitions.find((r) => r.from === a.song_id);
                const inRec = transitions.find((r) => r.to === a.song_id);
                return `
                  <div style="border:1px solid rgba(245,245,240,0.12);border-radius:14px;padding:12px">
                    <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;margin-bottom:8px">
                      <span style="font-weight:600">${idx + 1}. ${escHtml(a.title)} <span style="opacity:0.55">· ${escHtml(a.artist)}</span></span>
                      <span class="font-mono-num" style="font-size:12px;color:var(--amber)">
                        ${a.bpm} BPM · ${a.key_camelot || 'NO KEY'} · ${a.bar_count} BARS · ${a.instrumental_gaps?.length || 0} GAPS
                        ${a.warnings?.length ? ` · ⚠ ${escHtml(a.warnings.join(', '))}` : ''}
                      </span>
                    </div>
                    ${renderSongGridSvg(a, outRec?.mix_out_bar ?? null, inRec?.mix_in_bar ?? null)}
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderBrainModal({ claudeKeySet, health }) {
  return `
    <div class="modal-backdrop" id="brain-backdrop">
      <div class="modal-sheet" onclick="event.stopPropagation()">
        <div style="padding:22px 26px;display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid rgba(245,245,240,0.12)">
          <span class="font-display" style="font-size:32px;text-transform:uppercase">AI BRAIN &amp; ENGINES</span>
          <button id="btn-close-brain" class="exit-btn">✕</button>
        </div>
        <div class="nova-scroll" style="padding:20px 26px;overflow-y:auto;display:flex;flex-direction:column;gap:16px">
          <div style="font-size:14px;line-height:1.55;color:rgba(245,245,240,0.75)">
            <div><strong>Phase 1 Audio Analysis:</strong> ${health?.audioWorkerConfigured ? 'Python GPU Demucs + WhisperX Connected ✓' : 'Browser Essentia.js WASM + Spectral Mid-Side Matrix Active ✓'}</div>
            <div><strong>Phase 2 AI Planner:</strong> ${(health?.opusConfigured || claudeKeySet) ? 'Claude Opus + Compatibility Scorer + Validator Active ✓' : 'Deterministic Compatibility Scorer (S = T+K+E+P+V+G-R) + Validator Active ✓'}</div>
            <div><strong>YouTube Ingest:</strong> ${escHtml(health?.youtubeMode || 'public-extractor')} ✓</div>
            <div><strong>Database Persistence:</strong> ${health?.database?.connected ? `${escHtml(health.database.provider.toUpperCase())} Connected ✓` : 'Browser localStorage Persistence Active ✓'}</div>
          </div>

          <div style="border-top:1px solid rgba(245,245,240,0.12);padding-top:14px">
            <label class="font-display" style="font-size:20px;color:var(--amber);display:block;margin-bottom:8px">OPTIONAL: CLAUDE OPUS API KEY (SESSION ONLY)</label>
            <p style="font-size:13px;color:rgba(245,245,240,0.55);margin-bottom:10px">
              If <code>ANTHROPIC_API_KEY</code> is not set on Vercel, paste your Anthropic key here (kept only in this browser tab's <code>sessionStorage</code>) to let Claude Opus write creative transition recipes.
            </p>
            <div style="display:flex;gap:10px">
              <input id="input-opus-key" type="password" class="ingest-input" style="flex:1;height:52px" placeholder="sk-ant-api03-..." value="" />
              <button id="btn-save-opus-key" class="ingest-btn squeeze" style="height:52px;font-size:20px;padding:0 18px">SAVE KEY</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
