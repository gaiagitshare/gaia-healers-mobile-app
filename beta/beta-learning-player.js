(() => {
  const video = document.querySelector('video[data-course]');
  if (!video) return;
  const status = document.createElement('p');
  status.className = 'video-note'; status.setAttribute('role', 'status');
  video.after(status);
  video.addEventListener('loadedmetadata', () => {
    const position = Number(video.dataset.position);
    if (position > 0 && position < video.duration - 2) {
      video.currentTime = position; status.textContent = 'Resumed from your saved position.';
    }
  });
  let lastSaved = Number(video.dataset.position) || 0, busy = false, queued = false;
  async function save() {
    const seconds = Math.floor(video.currentTime);
    if(busy){queued=true;return;}
    if (Math.abs(seconds - lastSaved) < 2 || !Number.isFinite(seconds)) return;
    busy = true;
    try {
      const r = await fetch('/sandbox/learning-position', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({course:video.dataset.course,lesson:video.dataset.lesson,csrf:video.dataset.csrf,seconds})});
      if (!r.ok) throw Error('save'); lastSaved = seconds; status.textContent = 'Playback position saved.';
    } catch { status.textContent = 'Could not save your position. Pause again to retry.'; }
    finally { busy = false; if(queued){queued=false;save();} }
  }
  video.addEventListener('pause', save);
  video.addEventListener('timeupdate', () => {if(Math.abs(video.currentTime-lastSaved)>=15)save();});
  video.addEventListener('error', () => {status.textContent='This video could not be loaded. Check your connection and reload the lesson.';});
})();
