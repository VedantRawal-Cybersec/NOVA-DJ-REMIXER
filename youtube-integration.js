(() => {
  'use strict';
  if (window.__NOVA_YOUTUBE_INTEGRATION__) return;
  window.__NOVA_YOUTUBE_INTEGRATION__ = true;

  const QUEUE_KEY = 'nova.youtube.queue.v1';
  const style = document.createElement('style');
  style.textContent = `
    #nova-youtube{padding:clamp(34px,6vw,76px) 0;background:#0a0c0e;border-block:1px solid rgba(255,255,255,.08);color:#f2f3ed}
    #nova-youtube .ny-wrap{width:min(1200px,calc(100% - 40px));margin:auto}
    #nova-youtube .ny-kicker{color:#c5f36a;font:10px 'DM Mono',monospace;letter-spacing:.14em;margin-bottom:14px}
    #nova-youtube .ny-heading{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:24px}
    #nova-youtube h2{color:#f2f3ed;margin:0;font:700 clamp(28px,4vw,48px)/1.05 'Space Grotesk',sans-serif;letter-spacing:-.04em}
    #nova-youtube .ny-sub{color:#a3a89e;max-width:520px;font:13px/1.7 'Manrope',sans-serif;margin:0}
    #nova-youtube .ny-search-row,#nova-youtube .ny-paste{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin:20px 0 12px}
    #nova-youtube input{min-width:0;width:100%;box-sizing:border-box;background:#111518;color:#fff;border:1px solid #343a36;border-radius:10px;padding:15px 16px;outline:none;font:13px 'Manrope',sans-serif}
    #nova-youtube input:focus{border-color:#c5f36a;box-shadow:0 0 0 3px rgba(197,243,106,.1)}
    #nova-youtube button,#nova-youtube a.ny-btn{border:1px solid rgba(197,243,106,.4);border-radius:10px;padding:13px 16px;background:#c5f36a;color:#11150d;font:700 11px 'DM Mono',monospace;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px}
    #nova-youtube button.ny-ghost,#nova-youtube a.ny-ghost{color:#e8ecdf;background:#151a18;border-color:#343a36}
    #nova-youtube button:disabled{opacity:.55;cursor:wait}
    #nova-youtube .ny-tools{display:flex;flex-wrap:wrap;gap:9px;margin:12px 0 18px;align-items:center}
    #nova-youtube .ny-status{color:#aeb4a9;font:11px/1.6 'DM Mono',monospace;min-height:20px}
    #nova-youtube .ny-results{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0 28px}
    #nova-youtube .ny-card{min-width:0;border:1px solid #292f2b;border-radius:12px;background:#101412;overflow:hidden}
    #nova-youtube .ny-thumb{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#202722}
    #nova-youtube .ny-card-body{padding:12px}
    #nova-youtube .ny-title{color:#f3f4ee;font:700 13px/1.4 'Manrope',sans-serif;margin:0 0 6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:36px}
    #nova-youtube .ny-channel{color:#929b91;font:10px 'DM Mono',monospace;margin-bottom:10px}
    #nova-youtube .ny-card-actions{display:flex;gap:7px;flex-wrap:wrap}
    #nova-youtube .ny-card-actions button{padding:9px 10px;font-size:9px}
    #nova-youtube .ny-lower{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(250px,.8fr);gap:16px;align-items:start}
    #nova-youtube .ny-player-panel,#nova-youtube .ny-queue-panel{border:1px solid #292f2b;border-radius:14px;background:#101412;padding:14px;min-width:0}
    #nova-youtube .ny-panel-label{color:#c5f36a;font:10px 'DM Mono',monospace;letter-spacing:.1em;margin:0 0 12px}
    #nova-youtube .ny-player-frame{width:100%;aspect-ratio:16/9;background:#050606;border-radius:9px;overflow:hidden}
    #nova-youtube .ny-player-frame iframe{display:block;width:100%;height:100%;border:0}
    #nova-youtube .ny-now{color:#f1f2ec;margin:12px 0 4px;font:700 13px 'Manrope',sans-serif}
    #nova-youtube .ny-now-meta{color:#939b91;font:10px 'DM Mono',monospace}
    #nova-youtube .ny-paste{margin-top:14px}
    #nova-youtube .ny-paste input{padding:11px 12px;font-size:11px}
    #nova-youtube .ny-queue-list{display:grid;gap:8px;max-height:320px;overflow:auto}
    #nova-youtube .ny-queue-item{display:grid;grid-template-columns:48px minmax(0,1fr) auto;align-items:center;gap:9px;padding:8px;background:#171d19;border-radius:9px}
    #nova-youtube .ny-queue-item img{width:48px;height:34px;border-radius:5px;object-fit:cover}
    #nova-youtube .ny-queue-name{color:#e9ece4;font:600 10px/1.35 'Manrope',sans-serif;overflow:hidden}
    #nova-youtube .ny-queue-meta{color:#929b91;font:9px 'DM Mono',monospace;margin-top:3px}
    #nova-youtube .ny-empty{color:#929b91;font:11px/1.7 'Manrope',sans-serif;padding:14px 4px}
    #nova-youtube .ny-rights{color:#828a81;font:10px/1.6 'DM Mono',monospace;margin-top:16px}
    @media(max-width:800px){#nova-youtube .ny-heading{display:block}#nova-youtube .ny-sub{margin-top:12px}#nova-youtube .ny-results{grid-template-columns:repeat(2,minmax(0,1fr))}#nova-youtube .ny-lower{grid-template-columns:1fr}}
    @media(max-width:520px){#nova-youtube .ny-wrap{width:calc(100% - 28px)}#nova-youtube .ny-search-row,#nova-youtube .ny-paste{grid-template-columns:1fr}#nova-youtube .ny-results{grid-template-columns:1fr}#nova-youtube .ny-tools button{flex:1}}
  `;
  document.head.appendChild(style);

  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  function getQueue() {
    try {
      const items = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
      return Array.isArray(items) ? items.filter(item => item && item.videoId).slice(0, 50) : [];
    } catch (_) { return []; }
  }

  function videoIdFromUrl(value) {
    try {
      const url = new URL(value.trim());
      const host = url.hostname.toLowerCase();
      if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
      if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return null;
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const parts = url.pathname.split('/').filter(Boolean);
      return ['embed', 'shorts', 'live'].includes(parts[0]) ? parts[1] || null : null;
    } catch (_) { return null; }
  }

  function init() {
    if (document.getElementById('nova-youtube')) return;
    const discover = document.getElementById('discover');
    if (!discover) return;

    const section = make('section');
    section.id = 'nova-youtube';
    section.innerHTML = `
      <div class="ny-wrap">
        <div class="ny-heading">
          <div><div class="ny-kicker">04 / YOUTUBE MUSIC DISCOVERY</div><h2>Search it. Play it.<br>Keep the flow.</h2></div>
          <p class="ny-sub">Find official music uploads, play them inside NOVA's visible YouTube player, and build a YouTube queue. YouTube stays in playback mode and is not routed into the licensed DJ mixing decks.</p>
        </div>
        <div class="ny-search-row">
          <input id="ny-search" type="search" autocomplete="off" placeholder="Search songs, artists, Bollywood, Punjabi, EDM, remixes…">
          <button id="ny-search-btn" type="button">SEARCH YOUTUBE ↗</button>
        </div>
        <div class="ny-tools">
          <span id="ny-status" class="ny-status" role="status">YouTube player ready. Paste a video URL to play, or search the catalogue.</span>
          <a class="ny-btn ny-ghost" id="ny-open-search" target="_blank" rel="noopener noreferrer">OPEN YOUTUBE SEARCH ↗</a>
        </div>
        <div id="ny-results" class="ny-results" aria-live="polite"></div>
        <div class="ny-lower">
          <div class="ny-player-panel">
            <div class="ny-panel-label">YOUTUBE PLAYER / OFFICIAL EMBED</div>
            <div class="ny-player-frame" id="ny-player-frame"><div class="ny-empty">Choose a search result or paste a YouTube video URL.</div></div>
            <div id="ny-now" class="ny-now">Nothing playing</div>
            <div id="ny-now-meta" class="ny-now-meta">YouTube playback mode</div>
            <div class="ny-paste">
              <input id="ny-paste-url" type="url" placeholder="Paste a YouTube video URL…">
              <button id="ny-paste-play" type="button">PLAY LINK</button>
            </div>
          </div>
          <div class="ny-queue-panel">
            <div class="ny-panel-label">UP NEXT / YOUTUBE QUEUE</div>
            <div class="ny-tools">
              <button id="ny-play-next" type="button">PLAY NEXT ↗</button>
              <button id="ny-clear-queue" class="ny-ghost" type="button">CLEAR</button>
            </div>
            <div class="ny-queue-list" id="ny-queue"></div>
          </div>
        </div>
        <p class="ny-rights">Playback uses the official YouTube embedded player. Availability and embedding depend on the video owner and region. YouTube audio is not extracted, downloaded, hidden or routed into NOVA's remix engine.</p>
      </div>
    `;

    const studio = document.getElementById('studio');
    if (studio && studio.parentNode === discover.parentNode) discover.parentNode.insertBefore(section, studio);
    else discover.insertAdjacentElement('afterend', section);

    const nav = document.querySelector('.nav-links a[href="#discover"]');
    if (nav && !document.querySelector('.nav-links a[href="#nova-youtube"]')) {
      const link = make('a', '', 'YouTube');
      link.href = '#nova-youtube';
      nav.insertAdjacentElement('afterend', link);
    }

    const input = document.getElementById('ny-search');
    const searchButton = document.getElementById('ny-search-btn');
    const status = document.getElementById('ny-status');
    const results = document.getElementById('ny-results');
    const openSearch = document.getElementById('ny-open-search');
    const playerFrame = document.getElementById('ny-player-frame');
    const pasteInput = document.getElementById('ny-paste-url');
    const queueBox = document.getElementById('ny-queue');
    let queue = getQueue();

    function updateSearchLink() {
      openSearch.href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(input.value.trim() || 'music');
    }

    input.addEventListener('input', updateSearchLink);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') search(); });
    updateSearchLink();

    function renderQueue() {
      queueBox.innerHTML = '';
      if (!queue.length) {
        queueBox.appendChild(make('div', 'ny-empty', 'Your YouTube queue is empty.'));
        return;
      }
      queue.forEach((item, index) => {
        const row = make('div', 'ny-queue-item');
        const image = document.createElement('img');
        image.src = item.thumbnail || 'https://i.ytimg.com/vi/' + item.videoId + '/mqdefault.jpg';
        image.alt = '';
        const details = make('div');
        details.append(
          make('div', 'ny-queue-name', item.title || 'YouTube video'),
          make('div', 'ny-queue-meta', item.channelTitle || 'YouTube')
        );
        const actions = make('div');
        actions.style.display = 'flex';
        actions.style.gap = '4px';
        const playButton = make('button', 'ny-ghost', 'PLAY');
        playButton.type = 'button';
        playButton.addEventListener('click', () => play(item));
        const removeButton = make('button', 'ny-ghost', '×');
        removeButton.type = 'button';
        removeButton.addEventListener('click', () => {
          queue.splice(index, 1);
          saveQueue();
        });
        actions.append(playButton, removeButton);
        row.append(image, details, actions);
        queueBox.appendChild(row);
      });
    }

    function saveQueue() {
      try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(0, 50))); } catch (_) {}
      renderQueue();
    }

    function play(item) {
      if (!item || !item.videoId) return;
      playerFrame.innerHTML = '';
      const iframe = document.createElement('iframe');
      iframe.title = 'YouTube player: ' + (item.title || 'video');
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.allowFullscreen = true;
      const embed = new URL('https://www.youtube.com/embed/' + encodeURIComponent(item.videoId));
      embed.searchParams.set('autoplay', '1');
      embed.searchParams.set('playsinline', '1');
      embed.searchParams.set('rel', '0');
      embed.searchParams.set('enablejsapi', '1');
      embed.searchParams.set('origin', location.origin);
      iframe.src = embed.toString();
      playerFrame.appendChild(iframe);
      document.getElementById('ny-now').textContent = item.title || 'YouTube video';
      document.getElementById('ny-now-meta').textContent = (item.channelTitle || 'YouTube') + ' / Official embedded playback';
      status.textContent = 'Loading YouTube player. If embedding is disabled, open this video directly on YouTube.';
    }

    function addToQueue(item) {
      if (!item || !item.videoId) return;
      if (queue.some(existing => existing.videoId === item.videoId)) {
        status.textContent = 'That video is already in your queue.';
        return;
      }
      queue.push(item);
      saveQueue();
      status.textContent = 'Added to your YouTube queue.';
    }

    function renderResults(items) {
      results.innerHTML = '';
      if (!items.length) {
        results.appendChild(make('div', 'ny-empty', 'No embeddable videos were returned for this search.'));
        return;
      }
      items.forEach(item => {
        const card = make('article', 'ny-card');
        const image = document.createElement('img');
        image.className = 'ny-thumb';
        image.src = item.thumbnail || 'https://i.ytimg.com/vi/' + item.videoId + '/mqdefault.jpg';
        image.alt = '';
        image.loading = 'lazy';
        const body = make('div', 'ny-card-body');
        body.append(
          make('h3', 'ny-title', item.title),
          make('div', 'ny-channel', item.channelTitle + (item.duration ? ' / ' + item.duration : ''))
        );
        const actions = make('div', 'ny-card-actions');
        const playButton = make('button', '', 'PLAY HERE');
        const queueButton = make('button', 'ny-ghost', 'ADD TO QUEUE +');
        playButton.type = queueButton.type = 'button';
        playButton.addEventListener('click', () => play(item));
        queueButton.addEventListener('click', () => addToQueue(item));
        actions.append(playButton, queueButton);
        body.appendChild(actions);
        card.append(image, body);
        results.appendChild(card);
      });
    }

    async function search() {
      const query = input.value.trim();
      if (!query) {
        status.textContent = 'Enter a song, artist, remix or genre first.';
        input.focus();
        return;
      }
      updateSearchLink();
      searchButton.disabled = true;
      searchButton.textContent = 'SEARCHING…';
      status.textContent = 'Searching YouTube…';
      results.innerHTML = '';
      try {
        const response = await fetch('/api/youtube-search?q=' + encodeURIComponent(query) + '&limit=10', {
          headers: { accept: 'application/json' }
        });
        const data = await response.json();
        if (!response.ok) {
          status.textContent = data.message || data.error || 'YouTube search failed.';
          if (data.setupRequired) {
            results.appendChild(make('div', 'ny-empty', 'Paste a YouTube URL below to play now. In-app search needs the YOUTUBE_API_KEY Vercel Production environment variable.'));
          }
          return;
        }
        status.textContent = data.count + ' embeddable videos found for “' + query + '”.';
        renderResults(data.results || []);
      } catch (_) {
        status.textContent = 'Could not reach NOVA YouTube search. Open YouTube search or paste a video URL.';
      } finally {
        searchButton.disabled = false;
        searchButton.textContent = 'SEARCH YOUTUBE ↗';
      }
    }

    searchButton.addEventListener('click', search);
    document.getElementById('ny-paste-play').addEventListener('click', () => {
      const videoId = videoIdFromUrl(pasteInput.value);
      if (!videoId) {
        status.textContent = 'Enter a valid YouTube video URL.';
        return;
      }
      play({
        videoId,
        title: 'YouTube video',
        channelTitle: 'Pasted link',
        thumbnail: 'https://i.ytimg.com/vi/' + videoId + '/mqdefault.jpg'
      });
    });
    pasteInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') document.getElementById('ny-paste-play').click();
    });
    document.getElementById('ny-play-next').addEventListener('click', () => {
      if (!queue.length) {
        status.textContent = 'Your YouTube queue is empty.';
        return;
      }
      const next = queue.shift();
      saveQueue();
      play(next);
    });
    document.getElementById('ny-clear-queue').addEventListener('click', () => {
      queue = [];
      saveQueue();
      status.textContent = 'YouTube queue cleared.';
    });
    renderQueue();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();