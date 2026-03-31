/**
 * ═══════════════════════════════════════════════════════════════
 *  ROYAL FACE RECOGNITION ENGINE
 *  Dùng face-api.js (TensorFlow.js) — chạy hoàn toàn client-side
 *  Tác giả: Hệ Thống Hoàng Gia — Lê Công Hoan
 * ═══════════════════════════════════════════════════════════════
 *
 *  HƯỚNG DẪN TÍCH HỢP:
 *  1. Upload file này lên GitHub (ví dụ: royal-face.js)
 *  2. Upload thư mục /models lên GitHub (tải từ link bên dưới)
 *  3. Gửi raw link cho dev để tích hợp vào XML
 *
 *  MODELS CẦN THIẾT (tải về và upload lên GitHub):
 *  https://github.com/justadudewhohacks/face-api.js/tree/master/weights
 *  Cần 3 bộ model:
 *    - tiny_face_detector
 *    - face_landmark_68
 *    - face_recognition
 *
 *  ĐỂ DÙNG: Gọi RoyalFace.init() sau khi DOM sẵn sàng
 * ═══════════════════════════════════════════════════════════════
 */

(function (global) {
  'use strict';

  /* ─────────────────────────────────────────
     CẤU HÌNH — chỉnh sửa tại đây
  ───────────────────────────────────────── */
  var CONFIG = {
    // URL ảnh tham chiếu của công chúa
    REF_IMAGE_URL: 'https://i.postimg.cc/YCRKwXVN/777746d0-1788-4c3f-bb45-b5d3fc30c6be.jpg',

    // Ngưỡng nhận diện: 0.0 = giống hệt, 0.6 = thoáng giống
    // Khuyên dùng: 0.5 (chặt) hoặc 0.6 (thoáng)
    THRESHOLD: 0.75,

    // Đường dẫn thư mục models (relative hoặc CDN)
    // Nếu dùng CDN jsDelivr từ GitHub repo của bạn:
    // 'https://cdn.jsdelivr.net/gh/TEN_GITHUB/TEN_REPO@main/models'
    MODELS_URL: './models',

    // Thời gian quét tối đa (ms) trước khi timeout
    SCAN_TIMEOUT: 30000,

    // Bao nhiêu frame liên tiếp match thì xác nhận (tránh false positive)
    CONFIRM_FRAMES: 3,

    // Hiển thị debug overlay (bbox + tên)
    DEBUG_OVERLAY: false,

    // ID các element trong XML/HTML
    EL: {
      VIDEO:          'face-video',
      CANVAS:         'face-canvas',
      OVERLAY_CANVAS: 'face-debug-canvas',
      STATUS:         'face-status',
      BTN_SCAN:       'btn-face',
      EMOJI:          'face-emoji',
      SCAN_INNER:     'face-inner',
      CONTAINER:      'face-scan-wrap',
    }
  };

  /* ─────────────────────────────────────────
     TRẠNG THÁI NỘI BỘ
  ───────────────────────────────────────── */
  var state = {
    modelsLoaded:   false,
    refDescriptor:  null,
    stream:         null,
    scanning:       false,
    confirmed:      false,
    confirmCount:   0,
    scanTimer:      null,
    rafId:          null,
    onSuccess:      null,
    onFail:         null,
  };

  /* ─────────────────────────────────────────
     TIỆN ÍCH
  ───────────────────────────────────────── */
  function el(id) { return document.getElementById(id); }

  function setStatus(text, type) {
    var s = el(CONFIG.EL.STATUS);
    if (!s) return;
    s.textContent = text;
    s.className = 'face-status' + (type ? ' face-' + type : '');
  }

  function setEmoji(char) {
    var e = el(CONFIG.EL.EMOJI);
    if (e) e.textContent = char;
  }

  function setScanLine(active) {
    var inner = el(CONFIG.EL.SCAN_INNER);
    if (!inner) return;
    if (active) inner.classList.add('scanning');
    else        inner.classList.remove('scanning');
  }

  function haptic(ms) {
    if (navigator.vibrate) navigator.vibrate(ms || 20);
  }

  /* ─────────────────────────────────────────
     BƯỚC 1: TẢI MODELS face-api.js
  ───────────────────────────────────────── */
  function loadModels() {
    return Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(CONFIG.MODELS_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(CONFIG.MODELS_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(CONFIG.MODELS_URL),
    ]);
  }

  /* ─────────────────────────────────────────
     BƯỚC 2: TẠO DESCRIPTOR TỪ ẢNH THAM CHIẾU
  ───────────────────────────────────────── */
  function loadReferenceDescriptor() {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        faceapi
          .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions())
          .withFaceLandmarks(true)
          .withFaceDescriptor()
          .then(function (detection) {
            if (!detection) {
              reject(new Error('Không tìm thấy khuôn mặt trong ảnh tham chiếu!'));
              return;
            }
            state.refDescriptor = detection.descriptor;
            resolve(detection.descriptor);
          })
          .catch(reject);
      };
      img.onerror = function () {
        reject(new Error('Không tải được ảnh tham chiếu. Kiểm tra CORS / URL!'));
      };
      img.src = CONFIG.REF_IMAGE_URL + '?t=' + Date.now();
    });
  }

  /* ─────────────────────────────────────────
     BƯỚC 3: MỞ CAMERA
  ───────────────────────────────────────── */
  function openCamera() {
    return new Promise(function (resolve, reject) {
      var constraints = {
        video: {
          width:  { ideal: 320 },
          height: { ideal: 320 },
          facingMode: 'user',
        },
        audio: false,
      };

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        reject(new Error('Trình duyệt không hỗ trợ camera!'));
        return;
      }

      navigator.mediaDevices.getUserMedia(constraints)
        .then(function (stream) {
          state.stream = stream;

          // Tạo video element ẩn nếu chưa có
          var video = el(CONFIG.EL.VIDEO);
          if (!video) {
            video = document.createElement('video');
            video.id = CONFIG.EL.VIDEO;
            video.setAttribute('playsinline', '');
            video.setAttribute('muted', '');
            video.style.cssText =
              'position:absolute;opacity:0.001;width:320px;height:320px;' +
              'top:0;left:0;pointer-events:none;z-index:-1;border-radius:50%;';
            var container = el(CONFIG.EL.CONTAINER);
            if (container) container.appendChild(video);
            else           document.body.appendChild(video);
          }

          video.srcObject = stream;
          video.onloadedmetadata = function () {
            video.play().then(resolve).catch(reject);
          };
        })
        .catch(function (err) {
          if (err.name === 'NotAllowedError') {
            reject(new Error('Cần cấp quyền camera để xác minh khuôn mặt!'));
          } else {
            reject(err);
          }
        });
    });
  }

  /* ─────────────────────────────────────────
     BƯỚC 4: VÒNG LẶP NHẬN DIỆN REALTIME
  ───────────────────────────────────────── */
  function startScanLoop() {
    var video     = el(CONFIG.EL.VIDEO);
    var dbgCanvas = el(CONFIG.EL.OVERLAY_CANVAS);

    // Tạo debug canvas nếu cần
    if (CONFIG.DEBUG_OVERLAY && !dbgCanvas) {
      dbgCanvas = document.createElement('canvas');
      dbgCanvas.id = CONFIG.EL.OVERLAY_CANVAS;
      dbgCanvas.width  = 160;
      dbgCanvas.height = 160;
      dbgCanvas.style.cssText =
        'position:absolute;top:0;left:0;width:160px;height:160px;' +
        'border-radius:50%;z-index:5;pointer-events:none;';
      var inner = el(CONFIG.EL.SCAN_INNER);
      if (inner) inner.appendChild(dbgCanvas);
    }

    var opts = new faceapi.TinyFaceDetectorOptions({
      inputSize:    224,
      scoreThreshold: 0.4,
    });

    var frameCount = 0;
    var lastStatusTick = 0;
    var scanMessages = [
      'Đang phân tích khuôn mặt...',
      'Đối chiếu dữ liệu sinh trắc...',
      'Xác minh danh tính...',
      'Kiểm tra độ tương đồng...',
    ];

    function tick() {
      if (!state.scanning || state.confirmed) return;

      frameCount++;

      // Cập nhật status message mỗi 30 frame
      if (frameCount - lastStatusTick > 30) {
        lastStatusTick = frameCount;
        setStatus(scanMessages[Math.floor(frameCount / 30) % scanMessages.length]);
      }

      faceapi
        .detectSingleFace(video, opts)
        .withFaceLandmarks(true)
        .withFaceDescriptor()
        .then(function (detection) {
          if (!state.scanning || state.confirmed) return;

          if (!detection) {
            state.confirmCount = 0;
            if (frameCount % 15 === 0) setStatus('Không tìm thấy khuôn mặt — hãy nhìn thẳng vào camera...');
            state.rafId = requestAnimationFrame(tick);
            return;
          }

          // Vẽ debug
          if (CONFIG.DEBUG_OVERLAY && dbgCanvas) {
            var ctx = dbgCanvas.getContext('2d');
            ctx.clearRect(0, 0, dbgCanvas.width, dbgCanvas.height);
            // Scale box về kích thước canvas debug
            var scaleX = dbgCanvas.width  / video.videoWidth;
            var scaleY = dbgCanvas.height / video.videoHeight;
            var box = detection.detection.box;
            ctx.strokeStyle = '#c9a84c';
            ctx.lineWidth = 2;
            ctx.strokeRect(
              box.x * scaleX, box.y * scaleY,
              box.width * scaleX, box.height * scaleY
            );
          }

          // Tính khoảng cách Euclidean
          var distance = faceapi.euclideanDistance(
            detection.descriptor,
            state.refDescriptor
          );

          var matched = distance <= CONFIG.THRESHOLD;

          if (matched) {
            state.confirmCount++;
            setStatus('Đang xác nhận... (' + state.confirmCount + '/' + CONFIG.CONFIRM_FRAMES + ')');
            if (state.confirmCount >= CONFIG.CONFIRM_FRAMES) {
              onMatchSuccess(distance);
              return;
            }
          } else {
            state.confirmCount = 0;
            if (frameCount % 20 === 0) {
              var pct = Math.round((1 - distance / CONFIG.THRESHOLD) * 100);
              setStatus('Độ khớp: ' + Math.max(0, pct) + '% — tiếp tục nhìn thẳng...');
            }
          }

          state.rafId = requestAnimationFrame(tick);
        })
        .catch(function () {
          if (state.scanning) state.rafId = requestAnimationFrame(tick);
        });
    }

    state.rafId = requestAnimationFrame(tick);
  }

  /* ─────────────────────────────────────────
     KẾT QUẢ: MATCH THÀNH CÔNG
  ───────────────────────────────────────── */
  function onMatchSuccess(distance) {
    state.scanning  = false;
    state.confirmed = true;
    stopCamera();
    setScanLine(false);
    setEmoji('😊');
    setStatus('KHUÔN MẶT ĐÃ XÁC MINH ✓', 'ok');
    haptic(80);

    clearTimeout(state.scanTimer);

    // Confetti nếu có
    if (typeof confetti === 'function') {
      confetti({ particleCount: 50, spread: 65, origin: { y: 0.5 }, colors: ['#4caf50','#c9a84c','#fff'] });
    }

    if (typeof state.onSuccess === 'function') {
      state.onSuccess({ distance: distance });
    }
    // ✅ THÊM ĐÚNG DÒNG NÀY Ở ĐÂY LÀ XONG
    window.faceIdConfig.onSuccess();
  }

  /* ─────────────────────────────────────────
     KẾT QUẢ: TIMEOUT / THẤT BẠI
  ───────────────────────────────────────── */
  function onMatchFail(reason) {
    state.scanning = false;
    stopCamera();
    setScanLine(false);
    setEmoji('😐');
    setStatus('Xác minh thất bại: ' + (reason || 'Hết thời gian'), 'fail');
    haptic([25, 10, 25]);

    var btn = el(CONFIG.EL.BTN_SCAN);
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Thử Lại'; }

    if (typeof state.onFail === 'function') {
      state.onFail({ reason: reason });
    }
  }

  /* ─────────────────────────────────────────
     DỪNG CAMERA
  ───────────────────────────────────────── */
  function stopCamera() {
    if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.stop(); });
      state.stream = null;
    }
    var video = el(CONFIG.EL.VIDEO);
    if (video) { video.srcObject = null; }
  }

  /* ─────────────────────────────────────────
     API CÔNG KHAI
  ───────────────────────────────────────── */
  var RoyalFace = {

    /**
     * Khởi tạo engine — gọi 1 lần khi trang load
     * Trả về Promise
     */
    init: function (options) {
      // Merge options
      if (options) {
        if (options.refImageUrl)  CONFIG.REF_IMAGE_URL = options.refImageUrl;
        if (options.modelsUrl)    CONFIG.MODELS_URL    = options.modelsUrl;
        if (options.threshold)    CONFIG.THRESHOLD     = options.threshold;
        if (options.onSuccess)    state.onSuccess      = options.onSuccess;
        if (options.onFail)       state.onFail         = options.onFail;
        if (options.confirmFrames) CONFIG.CONFIRM_FRAMES = options.confirmFrames;
        if (options.debug)        CONFIG.DEBUG_OVERLAY = options.debug;
      }

      setStatus('Đang tải hệ thống nhận diện...');

      // Kiểm tra face-api đã load chưa
      if (typeof faceapi === 'undefined') {
        console.error('[RoyalFace] Chưa load face-api.js! Thêm script tag vào HTML.');
        setStatus('Lỗi: face-api.js chưa được tải!', 'fail');
        return Promise.reject(new Error('face-api.js not loaded'));
      }

      return loadModels()
        .then(function () {
          setStatus('Đang phân tích ảnh tham chiếu...');
          return loadReferenceDescriptor();
        })
        .then(function () {
          state.modelsLoaded = true;
          setStatus('Hệ thống sẵn sàng — nhấn nút quét khuôn mặt');
          var btn = el(CONFIG.EL.BTN_SCAN);
          if (btn) btn.disabled = false;
        })
        .catch(function (err) {
          console.error('[RoyalFace] Init error:', err);
          setStatus('Lỗi khởi tạo: ' + err.message, 'fail');
          return Promise.reject(err);
        });
    },

    /**
     * Bắt đầu quét khuôn mặt — gọi khi user nhấn nút
     */
    startScan: function () {
      if (!state.modelsLoaded) {
        setStatus('Hệ thống chưa sẵn sàng, vui lòng chờ...', 'fail');
        return;
      }
      if (state.scanning) return;
      if (state.confirmed) {
        setStatus('KHUÔN MẶT ĐÃ XÁC MINH ✓', 'ok');
        return;
      }

      state.scanning     = true;
      state.confirmCount = 0;

      var btn = el(CONFIG.EL.BTN_SCAN);
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Đang Quét...'; }

      setEmoji('👁️');
      setScanLine(true);
      setStatus('Đang mở camera...');
      haptic(15);

      openCamera()
        .then(function () {
          setStatus('Camera sẵn sàng — nhìn thẳng vào màn hình...');
          // Timeout sau SCAN_TIMEOUT ms
          state.scanTimer = setTimeout(function () {
            if (state.scanning && !state.confirmed) {
              onMatchFail('Hết thời gian (30 giây)');
            }
          }, CONFIG.SCAN_TIMEOUT);

          startScanLoop();
        })
        .catch(function (err) {
          state.scanning = false;
          setScanLine(false);
          setEmoji('😶');
          setStatus('Lỗi camera: ' + err.message, 'fail');
          var btn = el(CONFIG.EL.BTN_SCAN);
          if (btn) { btn.disabled = false; btn.textContent = '📷 Thử Lại'; }
        });
    },

    /**
     * Reset để quét lại (dùng khi muốn cho phép thử lại)
     */
    reset: function () {
      stopCamera();
      clearTimeout(state.scanTimer);
      cancelAnimationFrame(state.rafId);
      state.scanning     = false;
      state.confirmed    = false;
      state.confirmCount = 0;
      setScanLine(false);
      setEmoji('🧑');
      setStatus('Nhấn nút để bắt đầu quét khuôn mặt');
      var btn = el(CONFIG.EL.BTN_SCAN);
      if (btn) { btn.disabled = false; btn.textContent = '📷 Quét Khuôn Mặt'; }
    },

    /**
     * Kiểm tra đã xác minh chưa
     */
    isConfirmed: function () { return state.confirmed; },

    /**
     * Đặt callback
     */
    onSuccess: function (fn) { state.onSuccess = fn; return this; },
    onFail:    function (fn) { state.onFail    = fn; return this; },

    /**
     * Cập nhật threshold động
     */
    setThreshold: function (val) { CONFIG.THRESHOLD = val; return this; },

    /**
     * Expose config để debug
     */
    getConfig: function () { return CONFIG; },
  };

  /* ─────────────────────────────────────────
     EXPORT
  ───────────────────────────────────────── */
  global.RoyalFace = RoyalFace;

})(window);


/*
 * ═══════════════════════════════════════════════════════
 *  HƯỚNG DẪN TÍCH HỢP VÀO XML BLOGGER
 * ═══════════════════════════════════════════════════════
 *
 *  1. Upload file này + thư mục /models lên GitHub repo
 *
 *  2. Thêm vào phần <head> của XML:
 *
 *     <script src='https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.js'/>
 *     <script src='https://cdn.jsdelivr.net/gh/TEN_BAN/TEN_REPO@main/royal-face.js'/>
 *
 *  3. Trong phần GD3 (sinh trắc học), nút "Quét Khuôn Mặt":
 *
 *     <button id='btn-face' onclick='RoyalFace.startScan()'>📷 Quét Khuôn Mặt</button>
 *
 *  4. Trong script chính, khởi tạo:
 *
 *     RoyalFace.init({
 *       refImageUrl:   'https://i.postimg.cc/YCRKwXVN/777746d0-1788-4c3f-bb45-b5d3fc30c6be.jpg',
 *       modelsUrl:     'https://cdn.jsdelivr.net/gh/TEN_BAN/TEN_REPO@main/models',
 *       threshold:     0.55,       // 0.45=chặt, 0.6=thoáng
 *       confirmFrames: 3,          // số frame xác nhận liên tiếp
 *       onSuccess: function(res) {
 *         // faceOK = true;
 *         // checkBioComplete();
 *         faceOK = true;
 *         checkBioComplete();
 *       },
 *       onFail: function(res) {
 *         console.log('Thất bại:', res.reason);
 *       }
 *     });
 *
 *  5. Models cần download từ:
 *     https://github.com/justadudewhohacks/face-api.js/tree/master/weights
 *     Các file cần:
 *       tiny_face_detector_model-shard1
 *       tiny_face_detector_model-weights_manifest.json
 *       face_landmark_68_tiny_model-shard1
 *       face_landmark_68_tiny_model-weights_manifest.json
 *       face_recognition_model-shard1
 *       face_recognition_model-shard2
 *       face_recognition_model-weights_manifest.json
 *
 * ═══════════════════════════════════════════════════════
 */
