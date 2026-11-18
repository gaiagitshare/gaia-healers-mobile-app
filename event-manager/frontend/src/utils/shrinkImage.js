// Phone photos are 2-12 MB. Anything over 1.5 MB is resized in the browser
// (longest side 2000px) before upload so it always fits the server's limit.
// PNG stays PNG (a logo keeps its transparency); a file the browser cannot
// decode is sent unchanged and the server answers plainly. 18 Nov 2026.
export default function shrinkImage(file, maxSide = 2000, limit = 1500000) {
    return new Promise((resolve) => {
        if (!file || !/^image\//.test(file.type || '')
            || (file.size < limit && /jpe?g|png|webp|gif/.test(file.type))) { resolve(file); return; }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
            const c = document.createElement('canvas');
            c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            URL.revokeObjectURL(url);
            const png = file.type === 'image/png';
            c.toBlob((b) => resolve(b ? new File([b], png ? 'photo.png' : 'photo.jpg', { type: png ? 'image/png' : 'image/jpeg' }) : file),
                png ? 'image/png' : 'image/jpeg', 0.85);
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
        img.src = url;
    });
}
