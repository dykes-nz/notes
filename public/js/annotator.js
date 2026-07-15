/**
 * Notes App Annotator - PDF.js + Fabric.js Integration
 * Supports both blank canvas (ink) and PDF annotation modes
 * Optimized for iPad and Samsung Galaxy S25 with S Pen
 */
(function() {
  'use strict';

  // Detect device/browser
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isIOSSafari = isIOS || (isSafari && navigator.maxTouchPoints > 0);
  const isSamsungPen = /SM-S93|SM-S92|SM-S91|Galaxy.*S2[0-9]/.test(navigator.userAgent);

  // Mode: 'ink' for blank canvas, 'pdf' for PDF annotation
  const MODE = typeof ANNOTATOR_MODE !== 'undefined' ? ANNOTATOR_MODE : 'ink';
  const PDF_URL = typeof PDF_FILE_URL !== 'undefined' ? PDF_FILE_URL : null;

  // State
  let pdfDoc = null;
  let currentPage = 1;
  let totalPages = MODE === 'ink' ? 1 : 0;
  let renderScale = isIOSSafari ? 1.5 : 2.0;
  let zoomLevel = 1.0;
  let fitScale = 1.0;
  let currentTool = 'pen';

  // Tool settings persist across notes and sessions
  const savedToolSettings = (() => {
    try { return JSON.parse(localStorage.getItem('toolSettings')) || {}; }
    catch (e) { return {}; }
  })();

  let strokeColor = savedToolSettings.strokeColor || '#000000';
  let strokeWidth = savedToolSettings.strokeWidth || 1.44;
  let highlighterColor = savedToolSettings.highlighterColor || 'rgba(255,255,0,0.4)';
  let highlighterWidth = savedToolSettings.highlighterWidth || 20;
  let currentShape = 'line';
  let shapeColor = '#000000';
  let eraserMode = savedToolSettings.eraserMode || 'eraser';
  // Pen button draws either smooth ink ('pen') or textured graphite ('pencil')
  let penMode = savedToolSettings.penMode || 'pen';
  currentTool = penMode;

  function saveToolSettings() {
    try {
      localStorage.setItem('toolSettings', JSON.stringify({
        strokeColor, strokeWidth, highlighterColor, highlighterWidth,
        eraserMode, penMode
      }));
    } catch (e) {
      // Ignore storage errors
    }
  }

  // Shape drawing state
  let isDrawingShape = false;
  let shapeStartX = 0;
  let shapeStartY = 0;
  let tempShape = null;
  let activeShapeCanvas = null;

  // Page background template for blank ink pages (thin lines by default)
  let backgroundTemplate = 'lines-thin';

  // Insert space state
  let isInsertSpaceMode = false;
  let insertSpaceRect = null;
  let insertSpaceStartY = 0;
  let insertSpacePageNum = 0;

  // Per-page containers and Fabric.js canvases
  const pageContainers = {};
  const fabricCanvases = {};
  const canvasStates = {};
  const undoStacks = {};
  const redoStacks = {};
  // Suppresses undo tracking while a state is being restored (undo/redo)
  // or bulk-modified programmatically - object events fired during
  // loadFromJSON would otherwise re-serialise the canvas per object
  let isRestoringState = false;

  // Palm rejection state
  let stylusActive = false;
  let stylusTimeout = null;
  const STYLUS_TIMEOUT_MS = 500;

  // Palm rejection toggle: when on (default), fingers only scroll and
  // pinch-zoom - drawing is stylus-only. When off, fingers can draw.
  let palmRejectionOn = localStorage.getItem('palmRejection') !== 'off';
  let touchScrollLast = null; // one-finger scroll tracking while palm mode is on

  // Pinch zoom state
  let isPinching = false;
  let initialPinchDistance = 0;
  let initialZoomLevel = 1.0;
  let pinchCenterX = 0;
  let pinchCenterY = 0;
  const activeTouches = new Map();
  let lastPinchZoomTime = 0;
  const PINCH_THROTTLE_MS = isIOSSafari ? 50 : 16;

  // Pan state
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panScrollLeft = 0;
  let panScrollTop = 0;

  // DOM elements
  const pagesWrapper = document.getElementById('pages-wrapper');
  const pageInfo = document.getElementById('page-info');
  const loadingOverlay = document.getElementById('loading-overlay');

  // ============= INITIALIZATION =============

  async function init() {
    console.log('Annotator: Starting init, mode=' + MODE);

    if (typeof fabric === 'undefined') {
      if (loadingOverlay) {
        loadingOverlay.innerHTML = '<div class="text-center"><p class="text-red-600 mb-4">Failed to load annotation library</p><a href="/" class="text-blue-600 hover:underline">Back to Notes</a></div>';
      }
      return;
    }

    try {
      if (MODE === 'pdf' && PDF_URL) {
        // PDF mode - load PDF.js
        if (typeof pdfjsLib === 'undefined') {
          loadingOverlay.innerHTML = '<div class="text-center"><p class="text-red-600 mb-4">Failed to load PDF viewer library</p><a href="/" class="text-blue-600 hover:underline">Back to Notes</a></div>';
          return;
        }
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

        console.log('Loading PDF from:', PDF_URL);
        const loadingTask = pdfjsLib.getDocument(PDF_URL);
        pdfDoc = await loadingTask.promise;
        totalPages = pdfDoc.numPages;

        const firstPage = await pdfDoc.getPage(1);
        const unscaledViewport = firstPage.getViewport({ scale: 1 });
        const renderedWidth = unscaledViewport.width * renderScale;
        const viewerWidth = document.getElementById('canvas-viewer').clientWidth - 32;
        fitScale = viewerWidth / renderedWidth;

        await restoreState();
        await renderAllPages();
      } else {
        // Ink mode - blank canvas
        totalPages = 1;
        await restoreState();
        await renderBlankCanvas();
      }

      updatePageInfo();
      applyZoomToAllPages();
      updateZoomDisplay();
      setupEventListeners();
      setupToolbarDrag();
      setupDropdowns();
      // Enable scroll tracking for multi-page documents
      setupScrollListener();
      // Return to where this note was last left
      restoreScrollPosition();
      // Sharpen nearby pages if the restored zoom is above 100%
      scheduleResolutionUpdate();
      if (loadingOverlay) {
        loadingOverlay.style.display = 'none';
      }

    } catch (error) {
      console.error('Error initializing annotator:', error);
      if (loadingOverlay) {
        loadingOverlay.innerHTML = '<div class="text-center"><p class="text-red-600 mb-4">Failed to initialize</p><p class="text-gray-500 text-sm mb-4">' + (error.message || 'Unknown error') + '</p><a href="/" class="text-blue-600 hover:underline">Back to Notes</a></div>';
      }
    }
  }

  // ============= SMOOTH BRUSH =============

  fabric.SmoothPencilBrush = fabric.util.createClass(fabric.PencilBrush, {
    decimate: 1,

    // Capture high-frequency coalesced pointer samples (Apple Pencil
    // reports 240Hz; browsers deliver ~60 events/s with the rest
    // batched on the event). Each sample is fed through the normal
    // move handler so the live stroke and final path stay identical.
    onMouseMove: function(pointer, options) {
      const e = options && options.e;
      if (e && e.getCoalescedEvents) {
        const events = e.getCoalescedEvents();
        if (events.length > 1) {
          for (let i = 0; i < events.length; i++) {
            const p = this.canvas.getPointer(events[i]);
            this.callSuper('onMouseMove', new fabric.Point(p.x, p.y), options);
          }
          return;
        }
      }
      this.callSuper('onMouseMove', pointer, options);
    },

    // Same as PencilBrush._finalizeAndAddPath, except the live stroke on
    // the top context is kept until the final path has been painted on
    // the main canvas - removes the one-frame flash at pen lift
    _finalizeAndAddPath: function() {
      const ctx = this.canvas.contextTop;
      ctx.closePath();
      if (this.decimate) {
        this._points = this.decimatePoints(this._points, this.decimate);
      }
      const pathData = this.convertPointsToSVGPath(this._points).join('');
      if (!pathData || this._points.length < 2) {
        this.canvas.clearContext(this.canvas.contextTop);
        this.canvas.requestRenderAll();
        return;
      }

      const path = this.createPath(pathData);
      const canvas = this.canvas;

      canvas.fire('before:path:created', { path: path });
      canvas.add(path);
      path.setCoords();
      this._resetShadow();

      // Clear the live stroke only after the next full render has drawn
      // the final path underneath it
      const clearTop = function() {
        canvas.off('after:render', clearTop);
        canvas.clearContext(canvas.contextTop);
      };
      canvas.on('after:render', clearTop);
      canvas.requestRenderAll();

      canvas.fire('path:created', { path: path });
    },

    convertPointsToSVGPath: function(points) {
      const smoothedPoints = this._smoothPoints(points);
      return this._createSmoothPath(smoothedPoints);
    },

    _smoothPoints: function(points) {
      if (points.length < 3) return points;

      const result = [points[0]];
      for (let i = 1; i < points.length - 1; i += this.decimate) {
        result.push(points[i]);
      }
      result.push(points[points.length - 1]);
      return result;
    },

    _createSmoothPath: function(points) {
      if (points.length < 2) return [];

      const path = [];
      path.push(['M', points[0].x, points[0].y]);

      if (points.length === 2) {
        path.push(['L', points[1].x, points[1].y]);
        return path;
      }

      for (let i = 1; i < points.length - 1; i++) {
        const p0 = points[i - 1];
        const p1 = points[i];
        const p2 = points[i + 1];

        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;

        path.push(['Q', p1.x, p1.y, midX, midY]);
      }

      const last = points[points.length - 1];
      path.push(['L', last.x, last.y]);

      return path;
    }
  });

  // ============= PENCIL (TEXTURED) BRUSH =============

  // Repeating graphite-grain tiles, one per color. The tile is a canvas
  // element: fabric.Pattern serialises it as a data URL, so pencil
  // strokes survive save/reload without any custom restore logic.
  const pencilTileCache = {};

  function getPencilTile(color) {
    if (pencilTileCache[color]) return pencilTileCache[color];

    // Noise is generated at half size and upscaled 2x so grain cells stay
    // ~1 screen pixel under renderScale instead of dissolving into
    // sub-pixel dither
    const grain = 32;
    const noise = document.createElement('canvas');
    noise.width = noise.height = grain;
    const noiseCtx = noise.getContext('2d');

    const rgb = new fabric.Color(color).getSource();
    const img = noiseCtx.createImageData(grain, grain);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = rgb[0];
      d[i + 1] = rgb[1];
      d[i + 2] = rgb[2];
      // Mostly mid-tone graphite, lighter flecks where the paper tooth
      // shows through, and a few clear pinholes that keep the stroke
      // edges slightly ragged
      const v = Math.random();
      d[i + 3] = v < 0.08 ? Math.random() * 30
        : v < 0.28 ? 40 + Math.random() * 70
          : 110 + Math.random() * 115;
    }
    noiseCtx.putImageData(img, 0, 0);

    const tile = document.createElement('canvas');
    tile.width = tile.height = grain * 2;
    const tileCtx = tile.getContext('2d');
    tileCtx.imageSmoothingEnabled = false;
    tileCtx.drawImage(noise, 0, 0, tile.width, tile.height);

    pencilTileCache[color] = tile;
    return tile;
  }

  // Same geometry as the pen, but stroked with the grain pattern - the
  // finalised path gets a fabric.Pattern stroke (mirrors the stock
  // fabric.PatternBrush)
  fabric.PencilTextureBrush = fabric.util.createClass(fabric.SmoothPencilBrush, {
    getPattern: function() {
      return this.canvas.contextTop.createPattern(getPencilTile(this.color), 'repeat');
    },

    _setBrushStyles: function() {
      this.callSuper('_setBrushStyles');
      this.canvas.contextTop.strokeStyle = this.getPattern();
    },

    createPath: function(pathData) {
      const path = this.callSuper('createPath', pathData);
      const topLeft = path._getLeftTopCoords().scalarAdd(path.strokeWidth / 2);
      path.stroke = new fabric.Pattern({
        source: getPencilTile(this.color),
        offsetX: -topLeft.x,
        offsetY: -topLeft.y
      });
      return path;
    }
  });

  // ============= BLANK CANVAS RENDERING =============

  // Fixed page dimensions for ink mode (A4-like proportions)
  let inkPageWidth = 0;
  let inkPageHeight = 0;

  function calculateInkPageDimensions() {
    const viewer = document.getElementById('canvas-viewer');
    // Use A4 proportions (1:1.414) with a comfortable width
    inkPageWidth = Math.max(viewer.clientWidth - 32, 800) * renderScale;
    inkPageHeight = inkPageWidth * 1.414; // A4 aspect ratio
    // Zoom 1.0 shows the full page width, matching PDF mode. Without
    // this the page rendered at its backing-store size - on a phone
    // that is ~4x the screen width, beyond what pinch-out could fix
    fitScale = (viewer.clientWidth - 32) / inkPageWidth;
  }

  async function renderBlankCanvas() {
    pagesWrapper.innerHTML = '';
    calculateInkPageDimensions();

    // Reflect restored background template in the dropdown and overflow menu
    document.querySelectorAll('#bg-dropdown .bg-option, #overflow-menu .bg-option').forEach(o => {
      o.classList.toggle('active', o.dataset.bg === backgroundTemplate);
    });

    // Render all ink pages
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      await renderSingleInkPage(pageNum);
    }

    updateUndoRedoButtons();
  }

  async function renderSingleInkPage(pageNum) {
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page-container';
    pageContainer.id = 'page-container-' + pageNum;
    pageContainer.dataset.page = pageNum;
    pageContainer.style.width = inkPageWidth + 'px';
    pageContainer.style.height = inkPageHeight + 'px';
    pageContainer.style.position = 'relative';
    pageContainer.style.marginBottom = '20px';
    applyBackgroundToContainer(pageContainer);

    const annotationCanvas = document.createElement('canvas');
    annotationCanvas.id = 'annotation-canvas-' + pageNum;
    annotationCanvas.className = 'annotation-canvas';
    annotationCanvas.width = inkPageWidth;
    annotationCanvas.height = inkPageHeight;
    pageContainer.appendChild(annotationCanvas);

    pagesWrapper.appendChild(pageContainer);
    pageContainers[pageNum] = pageContainer;

    // Initialize Fabric.js canvas
    const fabricCanvas = new fabric.Canvas(annotationCanvas, {
      isDrawingMode: true,
      width: inkPageWidth,
      height: inkPageHeight,
      selection: false,
      allowTouchScrolling: false,
      enablePointerEvents: true,
      // renderScale already supersamples the backing store; letting
      // fabric multiply by devicePixelRatio on top of that produces
      // 30-megapixel canvases on high-DPI phones (S25 is dpr ~3) and
      // the whole page grinds
      enableRetinaScaling: false
    });

    // Base (100%) dimensions - the backing store is rescaled on zoom
    fabricCanvas.__baseWidth = inkPageWidth;
    fabricCanvas.__baseHeight = inkPageHeight;
    fabricCanvas.__resScale = 1;

    // Restore state if exists
    if (canvasStates[pageNum]) {
      await new Promise(resolve => {
        fabricCanvas.loadFromJSON(canvasStates[pageNum], () => {
          markEraserPaths(fabricCanvas);
          resolve();
        });
      });
    }

    // Initialize undo/redo stacks
    if (!undoStacks[pageNum]) undoStacks[pageNum] = [];
    if (!redoStacks[pageNum]) redoStacks[pageNum] = [];

    setupCanvasHandlers(fabricCanvas, pageNum, pageContainer);
    fabricCanvases[pageNum] = fabricCanvas;

    // Seed the baseline state so the first undo returns here instead of
    // clearing the page
    if (undoStacks[pageNum].length === 0) {
      saveToUndoStack(pageNum);
    }

    applyToolSettings(fabricCanvas);
  }

  // Add a new ink page
  window.addInkPage = async function() {
    if (MODE !== 'ink') return;

    totalPages++;
    await renderSingleInkPage(totalPages);
    applyZoomToPage(totalPages);
    updatePageInfo();

    // Scroll to new page
    const container = pageContainers[totalPages];
    if (container) {
      container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    if (thumbPanelOpen) renderAllThumbnails();

    // Auto-save
    saveState();
  };

  // ============= PDF RENDERING =============

  async function renderAllPages() {
    pagesWrapper.innerHTML = '';

    const pageDelay = isIOSSafari ? 50 : 0;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      try {
        if (pageDelay && pageNum > 1) {
          await new Promise(resolve => setTimeout(resolve, pageDelay));
        }
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: renderScale });

        const pageContainer = document.createElement('div');
        pageContainer.className = 'page-container';
        pageContainer.id = 'page-container-' + pageNum;
        pageContainer.dataset.page = pageNum;
        pageContainer.style.width = viewport.width + 'px';
        pageContainer.style.height = viewport.height + 'px';
        pageContainer.style.position = 'relative';
        pageContainer.style.marginBottom = '20px';

        // Create PDF canvas
        const pdfCanvas = document.createElement('canvas');
        pdfCanvas.className = 'pdf-canvas';
        pdfCanvas.width = viewport.width;
        pdfCanvas.height = viewport.height;
        pageContainer.appendChild(pdfCanvas);

        const ctx = pdfCanvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        // Create annotation canvas
        const annotationCanvas = document.createElement('canvas');
        annotationCanvas.id = 'annotation-canvas-' + pageNum;
        annotationCanvas.className = 'annotation-canvas';
        annotationCanvas.width = viewport.width;
        annotationCanvas.height = viewport.height;
        pageContainer.appendChild(annotationCanvas);

        pagesWrapper.appendChild(pageContainer);
        pageContainers[pageNum] = pageContainer;

        // Initialize Fabric.js canvas
        const fabricCanvas = new fabric.Canvas(annotationCanvas, {
          isDrawingMode: true,
          width: viewport.width,
          height: viewport.height,
          selection: false,
          allowTouchScrolling: false,
          enablePointerEvents: true,
          // See the ink canvas above: renderScale covers sharpness,
          // retina scaling on top explodes memory on high-DPI phones
          enableRetinaScaling: false
        });

        // Base (100%) dimensions - the backing store is rescaled on zoom
        fabricCanvas.__baseWidth = viewport.width;
        fabricCanvas.__baseHeight = viewport.height;
        fabricCanvas.__resScale = 1;

        // Restore state if exists
        if (canvasStates[pageNum]) {
          await new Promise(resolve => {
            fabricCanvas.loadFromJSON(canvasStates[pageNum], () => {
              markEraserPaths(fabricCanvas);
              resolve();
            });
          });
        }

        // Initialize undo/redo stacks
        if (!undoStacks[pageNum]) undoStacks[pageNum] = [];
        if (!redoStacks[pageNum]) redoStacks[pageNum] = [];

        setupCanvasHandlers(fabricCanvas, pageNum, pageContainer);
        fabricCanvases[pageNum] = fabricCanvas;

        // Seed the baseline state so the first undo returns here instead
        // of clearing the page
        if (undoStacks[pageNum].length === 0) {
          saveToUndoStack(pageNum);
        }

        applyToolSettings(fabricCanvas);
      } catch (pageError) {
        console.error('Error rendering page ' + pageNum + ':', pageError);
      }
    }

    updateUndoRedoButtons();
  }

  function setupCanvasHandlers(fabricCanvas, pageNum, pageContainer) {
    // Touch handling for upper canvas
    setTimeout(() => {
      const upperCanvas = pageContainer.querySelector('.upper-canvas');
      if (upperCanvas) {
        upperCanvas.style.touchAction = 'none';
        upperCanvas.style.webkitUserSelect = 'none';
        upperCanvas.style.userSelect = 'none';
        upperCanvas.style.webkitTouchCallout = 'none';

        upperCanvas.addEventListener('pointerdown', e => {
          if (e.pointerType === 'touch' && (palmRejectionOn || stylusActive)) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
          }
        }, { capture: true });

        upperCanvas.addEventListener('pointermove', e => {
          if (e.pointerType === 'touch' && (palmRejectionOn || stylusActive)) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
          }
        }, { capture: true });
      }
    }, 50);

    // Use smooth brush
    fabricCanvas.freeDrawingBrush = new fabric.SmoothPencilBrush(fabricCanvas);
    fabricCanvas.freeDrawingBrush.color = strokeColor;
    fabricCanvas.freeDrawingBrush.width = strokeWidth;

    // Moved ink rises above stationary eraser punches - a punch blanks
    // everything below it, so dragging older ink under one would blank
    // it too. Registered before undo tracking so the restack is part of
    // the same state change.
    fabricCanvas.on('object:modified', function(e) {
      if (isRestoringState || currentTool !== 'select' || !e.target) return;
      const hasPunches = fabricCanvas.getObjects().some(o => o.isEraser);
      if (!hasPunches) return;
      const targets = e.target.type === 'activeSelection'
        ? e.target.getObjects().slice()
        : [e.target];
      targets.forEach(o => {
        if (!o.isEraser) fabricCanvas.bringToFront(o);
      });
      fabricCanvas.requestRenderAll();
    });

    // Track changes for undo (skipped during undo/redo restores)
    fabricCanvas.on('object:added', function() {
      if (isRestoringState) return;
      saveToUndoStack(pageNum);
      redoStacks[pageNum] = [];
      updateUndoRedoButtons();
    });

    fabricCanvas.on('object:removed', function() {
      if (isRestoringState) return;
      saveToUndoStack(pageNum);
      updateUndoRedoButtons();
    });

    fabricCanvas.on('object:modified', function() {
      if (isRestoringState) return;
      saveToUndoStack(pageNum);
      redoStacks[pageNum] = [];
      updateUndoRedoButtons();
    });

    // Selection delete button lifecycle
    fabricCanvas.on('selection:created', function() { showDeleteButton(fabricCanvas); });
    fabricCanvas.on('selection:updated', function() { showDeleteButton(fabricCanvas); });
    fabricCanvas.on('selection:cleared', function() {
      if (selectionCanvas === fabricCanvas) hideDeleteButton();
    });
    // Follow the selection while it is dragged/scaled/rotated
    fabricCanvas.on('object:moving', positionDeleteButton);
    fabricCanvas.on('object:scaling', positionDeleteButton);
    fabricCanvas.on('object:rotating', positionDeleteButton);

    // Precision (EraserBrush) erasing modifies objects' clip paths without
    // adding anything to the canvas, so object events don't fire - snapshot
    // for undo here instead
    fabricCanvas.on('erasing:end', function(e) {
      if (isRestoringState) return;
      if (!e || !e.targets || e.targets.length === 0) return; // nothing erased
      saveToUndoStack(pageNum);
      redoStacks[pageNum] = [];
      updateUndoRedoButtons();
    });

  }

  // While a multi-object (lasso) selection is active, fabric holds the
  // selected objects' coordinates relative to the selection - serialising
  // in that state corrupts positions. Briefly drop and restore it.
  function canvasToJSON(canvas) {
    const active = canvas.getActiveObject();
    if (active && active.type === 'activeSelection') {
      const objs = active.getObjects();
      canvas.discardActiveObject();
      const json = canvas.toJSON(['globalCompositeOperation', 'isEraser']);
      const sel = new fabric.ActiveSelection(objs, { canvas: canvas });
      canvas.setActiveObject(sel);
      return json;
    }
    return canvas.toJSON(['globalCompositeOperation', 'isEraser']);
  }

  function saveToUndoStack(pageNum) {
    const canvas = fabricCanvases[pageNum];
    if (canvas) {
      const json = canvasToJSON(canvas);
      undoStacks[pageNum].push(JSON.stringify(json));
      if (undoStacks[pageNum].length > 50) {
        undoStacks[pageNum].shift();
      }
      scheduleThumbRefresh(pageNum);
    }
  }

  // ============= SCROLL TRACKING =============

  let scrollSaveTimer = null;

  function setupScrollListener() {
    const viewer = document.getElementById('canvas-viewer');

    viewer.addEventListener('scroll', () => {
      const viewerRect = viewer.getBoundingClientRect();
      const viewerCenterY = viewerRect.top + viewerRect.height / 2;

      let closestPage = 1;
      let closestDistance = Infinity;

      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        const container = pageContainers[pageNum];
        if (container) {
          const rect = container.getBoundingClientRect();
          const pageCenterY = rect.top + rect.height / 2;
          const distance = Math.abs(pageCenterY - viewerCenterY);

          if (distance < closestDistance) {
            closestDistance = distance;
            closestPage = pageNum;
          }
        }
      }

      if (closestPage !== currentPage) {
        currentPage = closestPage;
        updatePageInfo();
        updateThumbHighlight();
        // Newly-near pages may need their backing store upgraded
        scheduleResolutionUpdate();
      }

      // Keep the delete pill attached to the selection while scrolling
      if (selectionCanvas) positionDeleteButton();

      // Persist the exact scroll position (debounced)
      clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(saveScrollPosition, 500);
    });
  }

  // ============= LOCATION PERSISTENCE =============

  function getScrollKey() {
    return 'noteScroll_' + NOTE_ID;
  }

  function saveScrollPosition() {
    const viewer = document.getElementById('canvas-viewer');
    if (!viewer) return;
    try {
      localStorage.setItem(getScrollKey(), JSON.stringify({
        top: viewer.scrollTop,
        left: viewer.scrollLeft,
        zoom: zoomLevel,
        // v2: ink-mode zoom is fit-width-relative (fitScale applied)
        v: 2
      }));
    } catch (e) {
      // Ignore storage errors
    }
  }

  function restoreScrollPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(getScrollKey()));
      if (!saved) return;

      // Zoom must be restored first - scroll offsets depend on it
      let savedZoom = saved.zoom;
      if (savedZoom && MODE === 'ink' && saved.v !== 2 && fitScale > 0) {
        // Saved before ink zoom became fit-relative: convert so the
        // note appears at exactly the size it was left at
        savedZoom = Math.min(savedZoom / fitScale, 3.0);
      }
      if (savedZoom && Math.abs(savedZoom - zoomLevel) > 0.01) {
        zoomLevel = savedZoom;
        applyZoomToAllPages();
        updateZoomDisplay();
      }

      const viewer = document.getElementById('canvas-viewer');
      if (viewer) {
        viewer.scrollTop = saved.top || 0;
        viewer.scrollLeft = saved.left || 0;
      }
    } catch (e) {
      // Ignore parse/storage errors
    }
  }

  // ============= THUMBNAIL SIDEBAR =============

  let thumbPanelOpen = false;
  const thumbTimers = {};

  window.toggleThumbPanel = function() {
    thumbPanelOpen = !thumbPanelOpen;
    const panel = document.getElementById('thumb-panel');
    const container = document.querySelector('.annotator-container');
    panel?.classList.toggle('collapsed', !thumbPanelOpen);
    container?.classList.toggle('thumb-panel-open', thumbPanelOpen);
    document.getElementById('tool-thumbs')?.classList.toggle('active', thumbPanelOpen);
    if (thumbPanelOpen) {
      renderAllThumbnails();
    }
  };

  function renderAllThumbnails() {
    const list = document.getElementById('thumb-list');
    if (!list) return;
    list.innerHTML = '';

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const item = document.createElement('div');
      item.className = 'thumb-item' + (pageNum === currentPage ? ' current' : '');
      item.dataset.page = pageNum;

      const canvas = document.createElement('canvas');
      item.appendChild(canvas);

      const label = document.createElement('span');
      label.textContent = pageNum;
      item.appendChild(label);

      item.addEventListener('click', function() {
        pageContainers[pageNum]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });

      list.appendChild(item);
      drawThumbnail(pageNum, canvas);
    }
  }

  // Composite the page (PDF background if any, plus ink) into a small canvas
  function drawThumbnail(pageNum, targetCanvas) {
    const container = pageContainers[pageNum];
    const fc = fabricCanvases[pageNum];
    if (!container || !fc) return;

    const w = 300; // ~150 css px at 2x for sharpness
    const h = Math.max(1, Math.round(w * fc.height / fc.width));
    targetCanvas.width = w;
    targetCanvas.height = h;

    const ctx = targetCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    const pdfCanvas = container.querySelector('.pdf-canvas');
    if (pdfCanvas) {
      ctx.drawImage(pdfCanvas, 0, 0, w, h);
    }
    if (fc.lowerCanvasEl) {
      ctx.drawImage(fc.lowerCanvasEl, 0, 0, w, h);
    }
  }

  // Refresh a page's thumbnail a moment after its last change
  function scheduleThumbRefresh(pageNum) {
    if (!thumbPanelOpen) return;
    clearTimeout(thumbTimers[pageNum]);
    thumbTimers[pageNum] = setTimeout(() => {
      const canvas = document.querySelector('#thumb-list .thumb-item[data-page="' + pageNum + '"] canvas');
      if (canvas) drawThumbnail(pageNum, canvas);
    }, 2000);
  }

  function updateThumbHighlight() {
    if (!thumbPanelOpen) return;
    document.querySelectorAll('#thumb-list .thumb-item').forEach(item => {
      item.classList.toggle('current', parseInt(item.dataset.page) === currentPage);
    });
  }

  // ============= TOOL MANAGEMENT =============

  window.setTool = function(tool) {
    if (tool === 'eraser') {
      tool = eraserMode;
    }
    if (tool === 'pen') {
      tool = penMode;
    }

    // Exit insert-space mode if switching to another tool
    if (currentTool === 'insert-space' && tool !== 'insert-space') {
      exitInsertSpaceMode();
    }

    // Leaving select drops any active selection (and its delete pill)
    if (tool !== 'select') {
      Object.values(fabricCanvases).forEach(c => {
        if (c.getActiveObject()) {
          c.discardActiveObject();
          c.requestRenderAll();
        }
      });
      hideDeleteButton();
    }

    currentTool = tool;

    // Update UI - tool buttons
    document.querySelectorAll('.ftool-btn[data-tool]').forEach(btn => {
      const btnTool = btn.dataset.tool;
      const isActive = btnTool === tool ||
        (btnTool === 'pen' && (tool === 'pen' || tool === 'pencil')) ||
        (btnTool === 'eraser' && (tool === 'eraser' || tool === 'eraser-precision')) ||
        (btnTool === 'shape' && tool === 'shape') ||
        (btnTool === 'insert-space' && tool === 'insert-space');
      btn.classList.toggle('active', isActive);
    });

    closeAllDropdowns();

    const editorContent = document.getElementById('canvas-viewer');
    if (editorContent) {
      editorContent.classList.toggle('select-mode', tool === 'select');
      editorContent.classList.toggle('pan-mode', tool === 'pan');
      editorContent.classList.toggle('insert-space-mode', tool === 'insert-space');
    }

    // Enter insert-space mode
    if (tool === 'insert-space') {
      enterInsertSpaceMode();
    }

    // Apply to ALL canvases
    Object.values(fabricCanvases).forEach(canvas => {
      applyToolSettings(canvas);
    });
  };

  function applyToolSettings(canvas) {
    canvas.off('mouse:down');
    canvas.off('mouse:move');
    canvas.off('mouse:up');

    canvas.selection = (currentTool === 'select');
    canvas.perPixelTargetFind = false;

    switch (currentTool) {
      case 'select':
        canvas.isDrawingMode = false;
        canvas.defaultCursor = 'crosshair';
        canvas.selection = false; // lasso replaces the rectangle marquee
        attachLassoHandlers(canvas);
        canvas.forEachObject(obj => {
          obj.selectable = !obj.isEraser && !obj.excludeFromExport;
        });
        break;

      case 'pen':
        canvas.isDrawingMode = true;
        canvas.freeDrawingBrush = new fabric.SmoothPencilBrush(canvas);
        canvas.freeDrawingBrush.color = strokeColor;
        canvas.freeDrawingBrush.width = strokeWidth;
        canvas.defaultCursor = 'crosshair';
        canvas.forEachObject(obj => { obj.selectable = false; });
        break;

      case 'pencil':
        canvas.isDrawingMode = true;
        canvas.freeDrawingBrush = new fabric.PencilTextureBrush(canvas);
        canvas.freeDrawingBrush.color = strokeColor;
        canvas.freeDrawingBrush.width = strokeWidth;
        canvas.defaultCursor = 'crosshair';
        canvas.forEachObject(obj => { obj.selectable = false; });
        break;

      case 'highlighter':
        canvas.isDrawingMode = true;
        canvas.freeDrawingBrush = new fabric.SmoothPencilBrush(canvas);
        canvas.freeDrawingBrush.color = highlighterColor;
        canvas.freeDrawingBrush.width = highlighterWidth;
        canvas.defaultCursor = 'crosshair';
        canvas.forEachObject(obj => { obj.selectable = false; });
        break;

      case 'eraser':
        canvas.isDrawingMode = false;
        canvas.defaultCursor = 'pointer';
        // Per-pixel hit testing so dragging only erases strokes actually
        // crossed, not their bounding boxes
        canvas.perPixelTargetFind = true;
        canvas.targetFindTolerance = 12;
        attachEraserHandlers(canvas);
        canvas.forEachObject(obj => { obj.selectable = false; });
        break;

      case 'eraser-precision':
        canvas.isDrawingMode = true;
        // Per-object erasing: the eraser path attaches to each stroke it
        // crosses (in the stroke's own coordinate space), so erasures
        // move/scale/delete together with the ink
        canvas.freeDrawingBrush = new fabric.EraserBrush(canvas);
        canvas.freeDrawingBrush.width = strokeWidth * 3;
        canvas.defaultCursor = 'cell';
        canvas.forEachObject(obj => { obj.selectable = false; });
        break;

      case 'text':
        canvas.isDrawingMode = false;
        canvas.defaultCursor = 'text';
        canvas.on('mouse:down', createTextHandler(canvas));
        canvas.forEachObject(obj => { obj.selectable = false; });
        break;

      case 'shape':
        canvas.isDrawingMode = false;
        canvas.defaultCursor = 'crosshair';
        canvas.on('mouse:down', createShapeStartHandler(canvas));
        canvas.on('mouse:move', createShapeDrawHandler(canvas));
        canvas.on('mouse:up', createShapeEndHandler(canvas));
        canvas.forEachObject(obj => { obj.selectable = false; });
        break;

      case 'pan':
        canvas.isDrawingMode = false;
        canvas.defaultCursor = 'grab';
        canvas.selection = false;
        canvas.forEachObject(obj => { obj.selectable = false; });
        break;

      case 'insert-space':
        canvas.isDrawingMode = false;
        canvas.defaultCursor = 'row-resize';
        canvas.selection = false;
        canvas.forEachObject(obj => { obj.selectable = false; });
        // Re-attach insert-space handlers (they were removed by canvas.off above)
        const pageNum = parseInt(canvas.lowerCanvasEl?.id?.replace('annotation-canvas-', '') || '1');
        attachInsertSpaceHandlers(canvas, pageNum);
        break;
    }
  }

  // Attach insert-space mouse handlers to a canvas
  function attachInsertSpaceHandlers(canvas, pageNum) {
    canvas.on('mouse:down', function(e) {
      if (currentTool !== 'insert-space') return;

      const pointer = canvas.getPointer(e.e);
      insertSpaceStartY = pointer.y;
      insertSpacePageNum = pageNum;

      // Light grey rectangle showing how much space will be added
      insertSpaceRect = new fabric.Rect({
        left: 0,
        top: pointer.y,
        width: canvas.__baseWidth || canvas.width,
        height: 0,
        fill: 'rgba(107, 114, 128, 0.12)',
        stroke: 'rgba(107, 114, 128, 0.35)',
        strokeWidth: 1,
        strokeDashArray: [5, 5],
        selectable: false,
        evented: false,
        excludeFromExport: true
      });
      canvas.add(insertSpaceRect);
      canvas.renderAll();
    });

    canvas.on('mouse:move', function(e) {
      if (currentTool !== 'insert-space' || !insertSpaceRect) return;

      const pointer = canvas.getPointer(e.e);

      // Only allow dragging down
      insertSpaceRect.set({ height: Math.max(0, pointer.y - insertSpaceStartY) });
      canvas.renderAll();
    });

    canvas.on('mouse:up', function(e) {
      if (currentTool !== 'insert-space' || !insertSpaceRect) return;

      const pointer = canvas.getPointer(e.e);
      const spaceAmount = Math.max(0, pointer.y - insertSpaceStartY);

      // Remove the preview rectangle - the space is inserted on release
      canvas.remove(insertSpaceRect);
      insertSpaceRect = null;

      if (spaceAmount > 10) {
        // Actually insert the space
        insertVerticalSpace(insertSpacePageNum, insertSpaceStartY, spaceAmount);
      }

      canvas.renderAll();
      insertSpaceStartY = 0;
      insertSpacePageNum = 0;
    });
  }

  // Stroke eraser: tap an object or drag across objects to remove them
  let isErasing = false;

  function attachEraserHandlers(canvas) {
    const eraseAt = (e) => {
      const target = e.target || canvas.findTarget(e.e, true);
      // Never remove eraser hole-punch paths - deleting one would make
      // previously erased ink reappear
      if (target && !target.excludeFromExport && !target.isEraser) {
        canvas.remove(target);
        canvas.renderAll();
      }
    };

    canvas.on('mouse:down', (e) => {
      isErasing = true;
      eraseAt(e);
    });

    canvas.on('mouse:move', (e) => {
      if (isErasing) eraseAt(e);
    });

    canvas.on('mouse:up', () => {
      isErasing = false;
    });
  }

  // Safety: stop erasing if the pointer is released outside the canvas,
  // otherwise moving the pen afterwards would keep erasing on hover
  document.addEventListener('pointerup', () => { isErasing = false; });
  document.addEventListener('touchend', () => { isErasing = false; });

  // ============= FULLSCREEN =============

  // Hide the fullscreen button when running as a Home Screen web app -
  // there is no browser chrome to escape from
  if (window.navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches) {
    document.getElementById('fullscreen-btn')?.classList.add('hidden');
  }

  window.toggleFullscreen = function() {
    const doc = document;
    const el = doc.documentElement;
    const isFullscreen = doc.fullscreenElement || doc.webkitFullscreenElement;

    if (isFullscreen) {
      (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
    } else {
      const request = el.requestFullscreen || el.webkitRequestFullscreen;
      if (request) {
        request.call(el);
      } else {
        alert('Full screen is not supported in this browser. Tip: add this site to your Home Screen for a full-screen app.');
      }
    }
  };

  // ============= PALM REJECTION TOGGLE =============

  window.togglePalmRejection = function() {
    palmRejectionOn = !palmRejectionOn;
    localStorage.setItem('palmRejection', palmRejectionOn ? 'on' : 'off');
    document.getElementById('palm-toggle')?.classList.toggle('palm-active', palmRejectionOn);
  };

  // Reflect initial state on the toolbar button
  document.getElementById('palm-toggle')?.classList.toggle('palm-active', palmRejectionOn);

  // Reflect restored tool settings in the dropdowns
  (function syncToolSettingsUI() {
    document.querySelectorAll('#pen-dropdown .color-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === strokeColor);
    });
    document.querySelectorAll('#pen-dropdown .width-line').forEach(line => {
      line.style.backgroundColor = strokeColor;
    });
    document.querySelectorAll('#pen-dropdown .width-option').forEach(o => {
      o.classList.toggle('active', parseFloat(o.dataset.width) === strokeWidth);
    });

    document.querySelectorAll('#pen-dropdown .eraser-mode').forEach(m => {
      m.classList.toggle('active', m.dataset.mode === penMode);
    });

    document.querySelectorAll('#highlighter-dropdown .color-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === highlighterColor);
    });
    const previewColor = highlighterColor.replace(/[\d.]+\)$/, '0.6)');
    document.querySelectorAll('#highlighter-dropdown .width-line').forEach(line => {
      line.style.background = previewColor;
    });
    document.querySelectorAll('#highlighter-dropdown .width-option').forEach(o => {
      o.classList.toggle('active', parseInt(o.dataset.width) === highlighterWidth);
    });

    document.querySelectorAll('#eraser-dropdown .eraser-mode').forEach(m => {
      m.classList.toggle('active', m.dataset.mode === eraserMode);
    });
  })();

  // ============= SELECTION DELETE BUTTON =============
  // A floating Delete pill appears above whatever is selected

  let selectionCanvas = null; // canvas owning the current selection

  function showDeleteButton(canvas) {
    selectionCanvas = canvas;
    positionDeleteButton();
    document.getElementById('selection-delete-btn')?.classList.add('visible');
  }

  function hideDeleteButton() {
    selectionCanvas = null;
    document.getElementById('selection-delete-btn')?.classList.remove('visible');
  }

  function positionDeleteButton() {
    const btn = document.getElementById('selection-delete-btn');
    const canvas = selectionCanvas;
    if (!btn || !canvas) return;
    const active = canvas.getActiveObject();
    if (!active) return;

    const br = active.getBoundingRect();
    const upperRect = canvas.upperCanvasEl.getBoundingClientRect();
    const factor = upperRect.width / canvas.getWidth();

    const safeTop = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--safe-area-top')
    ) || 0;

    const x = upperRect.left + (br.left + br.width / 2) * factor;
    const y = upperRect.top + br.top * factor - 46;

    btn.style.left = Math.min(Math.max(x, 60), window.innerWidth - 60) + 'px';
    btn.style.top = Math.max(y, safeTop + 8) + 'px';
  }

  window.deleteSelection = function() {
    const canvas = selectionCanvas;
    if (!canvas) return;
    const active = canvas.getActiveObject();
    if (!active) return;

    const objs = active.type === 'activeSelection' ? active.getObjects().slice() : [active];
    const pageNum = parseInt(
      Object.keys(fabricCanvases).find(k => fabricCanvases[k] === canvas)
    ) || currentPage;

    canvas.discardActiveObject();

    // One undo entry for the whole deletion, not one per object
    isRestoringState = true;
    objs.forEach(o => canvas.remove(o));
    isRestoringState = false;

    saveToUndoStack(pageNum);
    redoStacks[pageNum] = [];
    updateUndoRedoButtons();
    canvas.requestRenderAll();
    hideDeleteButton();
    saveState();
  };

  // ============= LASSO SELECT =============
  // Drag on empty space with the select tool to draw a dotted lasso;
  // on release, everything inside it or touching its edge becomes one
  // combined selection. Tapping an object directly still selects it.

  let lassoPoints = null;
  let lassoCanvas = null;

  function attachLassoHandlers(canvas) {
    canvas.on('mouse:down', (e) => {
      if (currentTool !== 'select') return;
      if (e.target) return; // direct tap on an object - normal selection
      lassoCanvas = canvas;
      lassoPoints = [canvas.getPointer(e.e)];
    });

    canvas.on('mouse:move', (e) => {
      if (!lassoPoints || lassoCanvas !== canvas) return;
      const p = canvas.getPointer(e.e);
      const last = lassoPoints[lassoPoints.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < 3) return;
      lassoPoints.push(p);
      drawLassoOutline(canvas);
    });

    canvas.on('mouse:up', () => {
      if (!lassoPoints || lassoCanvas !== canvas) return;
      const points = lassoPoints;
      lassoPoints = null;
      lassoCanvas = null;
      canvas.clearContext(canvas.contextTop);

      if (points.length < 3) return; // a tap, not a lasso

      const selected = canvas.getObjects().filter(obj =>
        !obj.excludeFromExport && !obj.isEraser && obj.selectable !== false &&
        !isFullyPunchedOut(obj, canvas) &&
        objectTouchesLasso(obj, points)
      );

      if (selected.length === 1) {
        canvas.setActiveObject(selected[0]);
      } else if (selected.length > 1) {
        const sel = new fabric.ActiveSelection(selected, { canvas: canvas });
        canvas.setActiveObject(sel);
      }
      canvas.requestRenderAll();
    });
  }

  function drawLassoOutline(canvas) {
    const ctx = canvas.contextTop;
    const retina = canvas.getRetinaScaling();
    const vt = canvas.viewportTransform;
    const scale = vt[0] || 1;

    canvas.clearContext(ctx);
    ctx.save();
    ctx.setTransform(retina, 0, 0, retina, 0, 0);
    ctx.transform(vt[0], vt[1], vt[2], vt[3], vt[4], vt[5]);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([6 / scale, 4 / scale]);
    ctx.beginPath();
    ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
    for (let i = 1; i < lassoPoints.length; i++) {
      ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if (((yi > pt.y) !== (yj > pt.y)) &&
          (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function segmentsIntersect(a, b, c, d) {
    const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  }

  // An object whose bounds are entirely inside a later (higher-stacked)
  // eraser punch is invisible - the lasso should not pick up such ghosts
  function isFullyPunchedOut(obj, canvas) {
    const objs = canvas.getObjects();
    const idx = objs.indexOf(obj);
    const r = obj.getBoundingRect(true, true);

    for (let i = idx + 1; i < objs.length; i++) {
      const p = objs[i];
      if (!p.isEraser) continue;
      const e = p.getBoundingRect(true, true);
      if (e.left <= r.left && e.top <= r.top &&
          e.left + e.width >= r.left + r.width &&
          e.top + e.height >= r.top + r.height) {
        return true;
      }
    }
    return false;
  }

  // Object counts as lassoed if its bounding box is inside the lasso or
  // touches its edge
  function objectTouchesLasso(obj, poly) {
    const r = obj.getBoundingRect(true, true);
    const corners = [
      { x: r.left, y: r.top },
      { x: r.left + r.width, y: r.top },
      { x: r.left + r.width, y: r.top + r.height },
      { x: r.left, y: r.top + r.height }
    ];

    // Any corner inside the lasso
    if (corners.some(c => pointInPolygon(c, poly))) return true;

    // Any lasso point inside the box (lasso drawn within a big object)
    if (poly.some(p =>
      p.x >= r.left && p.x <= r.left + r.width &&
      p.y >= r.top && p.y <= r.top + r.height)) return true;

    // Lasso edge crossing a box edge
    const edges = [
      [corners[0], corners[1]], [corners[1], corners[2]],
      [corners[2], corners[3]], [corners[3], corners[0]]
    ];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length]; // includes the closing segment
      if (edges.some(([c, d]) => segmentsIntersect(a, b, c, d))) return true;
    }
    return false;
  }

  // Eraser hole-punch paths must never be hit-testable or selectable
  function markEraserPaths(canvas) {
    canvas.getObjects().forEach(o => {
      if (o.isEraser) {
        o.selectable = false;
        o.evented = false;
      }
    });
  }

  function createTextHandler(canvas) {
    return function(e) {
      if (e.target) return;

      const pointer = canvas.getPointer(e.e);
      const text = new fabric.IText('Text', {
        left: pointer.x,
        top: pointer.y,
        fontSize: 24 * renderScale / 2,
        fill: strokeColor,
        fontFamily: 'Arial',
        editable: true
      });

      canvas.add(text);
      canvas.setActiveObject(text);
      text.enterEditing();
      text.selectAll();
      canvas.renderAll();
    };
  }

  function createShapeStartHandler(canvas) {
    return function(e) {
      if (e.target) return;

      const pointer = canvas.getPointer(e.e);
      isDrawingShape = true;
      shapeStartX = pointer.x;
      shapeStartY = pointer.y;
      activeShapeCanvas = canvas;

      tempShape = createShape(shapeStartX, shapeStartY, 0, 0);
      if (tempShape) {
        tempShape.set({ selectable: false, evented: false });
        canvas.add(tempShape);
      }
    };
  }

  function createShapeDrawHandler(canvas) {
    return function(e) {
      if (!isDrawingShape || !tempShape || activeShapeCanvas !== canvas) return;

      const pointer = canvas.getPointer(e.e);
      const width = pointer.x - shapeStartX;
      const height = pointer.y - shapeStartY;

      updateShapeSize(tempShape, shapeStartX, shapeStartY, width, height, canvas);
      canvas.renderAll();
    };
  }

  function createShapeEndHandler(canvas) {
    return function(e) {
      if (!isDrawingShape || activeShapeCanvas !== canvas) return;

      isDrawingShape = false;
      activeShapeCanvas = null;

      if (tempShape) {
        const bounds = tempShape.getBoundingRect();
        if (bounds.width < 5 && bounds.height < 5) {
          canvas.remove(tempShape);
        } else {
          tempShape.set({
            selectable: true,
            evented: true,
            hasControls: true,
            hasBorders: true,
            lockUniScaling: false
          });
          tempShape.setCoords();

          for (const [pageNum, c] of Object.entries(fabricCanvases)) {
            if (c === canvas) {
              saveToUndoStack(parseInt(pageNum));
              break;
            }
          }

          canvas.discardActiveObject();
        }
        tempShape = null;
      }
      canvas.renderAll();
    };
  }

  // ============= PAGE BACKGROUND TEMPLATES =============

  // CSS pattern for a template, sized in canvas px (page is A4: 210mm wide)
  function backgroundCss(template) {
    const pxPerMm = inkPageWidth / 210;
    const lineW = Math.max(1, Math.round(pxPerMm * 0.2));
    const lineColor = '#dbe2ea';

    switch (template) {
      case 'dots': {
        const s = Math.round(pxPerMm * 5);
        const r = Math.max(1, pxPerMm * 0.18);
        return {
          image: 'radial-gradient(circle, #d5dbe4 ' + r + 'px, transparent ' + r + 'px)',
          size: s + 'px ' + s + 'px'
        };
      }
      case 'lines-thin': {
        const s = Math.round(pxPerMm * 7);
        return {
          image: 'linear-gradient(to bottom, ' + lineColor + ' ' + lineW + 'px, transparent ' + lineW + 'px)',
          size: '100% ' + s + 'px'
        };
      }
      case 'lines-wide': {
        const s = Math.round(pxPerMm * 10);
        return {
          image: 'linear-gradient(to bottom, ' + lineColor + ' ' + lineW + 'px, transparent ' + lineW + 'px)',
          size: '100% ' + s + 'px'
        };
      }
      case 'grid': {
        const s = Math.round(pxPerMm * 5);
        return {
          image: 'linear-gradient(to bottom, ' + lineColor + ' ' + lineW + 'px, transparent ' + lineW + 'px), ' +
                 'linear-gradient(to right, ' + lineColor + ' ' + lineW + 'px, transparent ' + lineW + 'px)',
          size: s + 'px ' + s + 'px'
        };
      }
      default:
        return null; // blank
    }
  }

  function applyBackgroundToContainer(container) {
    const css = MODE === 'ink' ? backgroundCss(backgroundTemplate) : null;
    container.style.background = 'white';
    if (css) {
      container.style.backgroundImage = css.image;
      container.style.backgroundSize = css.size;
    }
  }

  window.setPageBackground = function(template) {
    backgroundTemplate = template;
    Object.values(pageContainers).forEach(applyBackgroundToContainer);
    document.querySelectorAll('#bg-dropdown .bg-option, #overflow-menu .bg-option').forEach(o => {
      o.classList.toggle('active', o.dataset.bg === template);
    });
    closeAllDropdowns();
    saveState();
  };

  // ============= INSERT SPACE TOOL =============

  function enterInsertSpaceMode() {
    isInsertSpaceMode = true;
    // Disable drawing on all canvases
    Object.values(fabricCanvases).forEach(canvas => {
      canvas.isDrawingMode = false;
      canvas.selection = false;
    });
  }

  function exitInsertSpaceMode() {
    isInsertSpaceMode = false;
    // Remove any in-progress preview rectangle
    if (insertSpaceRect && insertSpacePageNum && fabricCanvases[insertSpacePageNum]) {
      fabricCanvases[insertSpacePageNum].remove(insertSpaceRect);
      fabricCanvases[insertSpacePageNum].renderAll();
    }
    insertSpaceRect = null;
    insertSpaceStartY = 0;
    insertSpacePageNum = 0;
  }

  // Insert vertical space by moving objects down. Page height is fixed:
  // objects that end up within BOTTOM_MARGIN of the page bottom transfer to
  // the top of the next page, pushing that page's content down - cascading
  // through all pages (a new final page is added if needed).
  async function insertVerticalSpace(startPage, yPosition, amount) {
    const BOTTOM_MARGIN = 20; // transfer zone at the bottom of each page
    const TOP_MARGIN = 20;    // arrivals land this far from the top
    const ARRIVAL_GAP = 20;   // gap between arrivals and pushed-down content

    const objBottom = (obj) => obj.top + obj.height * obj.scaleY;

    let carry = []; // { obj, offset } group moving to the next page

    // Suppress per-object undo tracking; one snapshot per page at the end
    isRestoringState = true;

    for (let pageNum = startPage; pageNum <= totalPages; pageNum++) {
      const canvas = fabricCanvases[pageNum];
      if (!canvas) break;
      if (pageNum > startPage && carry.length === 0) break; // cascade finished

      if (!undoStacks[pageNum]) undoStacks[pageNum] = [];

      // Page geometry in base coordinates (backing store may be scaled)
      const baseHeight = canvas.__baseHeight || canvas.height;
      const limit = baseHeight - BOTTOM_MARGIN;
      const existing = canvas.getObjects().filter(o => !o.excludeFromExport);
      const moved = new Set();

      if (pageNum === startPage) {
        // Objects whose top edge is at/below the insertion point move down.
        // Strokes straddling the line stay put.
        existing.forEach(obj => {
          if (obj.top >= yPosition) {
            obj.set({ top: obj.top + amount });
            moved.add(obj);
          }
        });
      } else {
        // Place arrivals at the top as a group, preserving relative spacing
        let arrivalsBottom = TOP_MARGIN;
        carry.forEach(({ obj, offset }) => {
          obj.set({ top: TOP_MARGIN + offset });
          canvas.add(obj);
          moved.add(obj);
          arrivalsBottom = Math.max(arrivalsBottom, objBottom(obj));
        });
        carry = [];

        // Push existing content down just enough to clear the arrivals
        if (existing.length > 0) {
          const existingTop = Math.min(...existing.map(o => o.top));
          const push = arrivalsBottom + ARRIVAL_GAP - existingTop;
          if (push > 0) {
            existing.forEach(obj => {
              obj.set({ top: obj.top + push });
              moved.add(obj);
            });
          }
        }
      }

      // Moved objects now within BOTTOM_MARGIN of the page bottom transfer
      // to the next page (objects too tall to ever fit a page stay put)
      const maxFit = limit - TOP_MARGIN;
      const overflow = canvas.getObjects()
        .filter(o => !o.excludeFromExport && moved.has(o) &&
                     objBottom(o) > limit && (o.height * o.scaleY) <= maxFit)
        .sort((a, b) => a.top - b.top);

      if (overflow.length > 0) {
        const groupTop = Math.min(...overflow.map(o => o.top));
        carry = overflow.map(obj => {
          canvas.remove(obj);
          return { obj: obj, offset: obj.top - groupTop };
        });

        // Extend the document if the cascade reaches past the last page
        if (pageNum === totalPages) {
          await addInkPage();
        }
      }

      canvas.getObjects().forEach(o => o.setCoords());
      canvas.renderAll();

      // One undo entry for this page's reflow
      saveToUndoStack(pageNum);
    }

    isRestoringState = false;

    if (thumbPanelOpen) renderAllThumbnails();

    // Save state
    saveState();
    updateUndoRedoButtons();
  }

  // ============= DROPDOWN CONTROLS =============

  window.setPenColor = function(color) {
    strokeColor = color;
    document.querySelectorAll('#pen-dropdown .color-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === color);
    });

    document.querySelectorAll('#pen-dropdown .width-line').forEach(line => {
      line.style.backgroundColor = color;
    });

    Object.values(fabricCanvases).forEach(canvas => {
      if (canvas && canvas.freeDrawingBrush && (currentTool === 'pen' || currentTool === 'pencil')) {
        canvas.freeDrawingBrush.color = strokeColor;
      }
    });
    saveToolSettings();
  };

  window.setPenWidth = function(width) {
    strokeWidth = width;
    document.querySelectorAll('#pen-dropdown .width-option').forEach(o => {
      o.classList.toggle('active', parseFloat(o.dataset.width) === width);
    });

    Object.values(fabricCanvases).forEach(canvas => {
      if (canvas && canvas.freeDrawingBrush && (currentTool === 'pen' || currentTool === 'pencil')) {
        canvas.freeDrawingBrush.width = strokeWidth;
      }
    });
    saveToolSettings();
  };

  window.setPenMode = function(mode) {
    penMode = mode;
    document.querySelectorAll('#pen-dropdown .eraser-mode').forEach(m => {
      m.classList.toggle('active', m.dataset.mode === mode);
    });
    saveToolSettings();
    setTool('pen');
  };

  window.setHighlighterColor = function(color) {
    highlighterColor = color;
    document.querySelectorAll('#highlighter-dropdown .color-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === color);
    });

    const previewColor = color.replace(/[\d.]+\)$/, '0.6)');
    document.querySelectorAll('#highlighter-dropdown .width-line').forEach(line => {
      line.style.background = previewColor;
    });

    Object.values(fabricCanvases).forEach(canvas => {
      if (canvas && canvas.freeDrawingBrush && currentTool === 'highlighter') {
        canvas.freeDrawingBrush.color = highlighterColor;
      }
    });
    saveToolSettings();
  };

  window.setHighlighterWidth = function(width) {
    highlighterWidth = width;
    document.querySelectorAll('#highlighter-dropdown .width-option').forEach(o => {
      o.classList.toggle('active', parseInt(o.dataset.width) === width);
    });

    Object.values(fabricCanvases).forEach(canvas => {
      if (canvas && canvas.freeDrawingBrush && currentTool === 'highlighter') {
        canvas.freeDrawingBrush.width = highlighterWidth;
      }
    });
    saveToolSettings();
  };

  window.setEraserMode = function(mode) {
    eraserMode = mode;
    document.querySelectorAll('#eraser-dropdown .eraser-mode').forEach(m => {
      m.classList.toggle('active', m.dataset.mode === mode);
    });
    saveToolSettings();
    setTool('eraser');
  };

  window.setShape = function(shape) {
    currentShape = shape;
    document.querySelectorAll('#shape-dropdown .option-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.shape === shape);
    });

    const shapeIcon = document.getElementById('shape-icon');
    if (shapeIcon) {
      const iconSvg = {
        line: '<line x1="5" y1="19" x2="19" y2="5" stroke-width="2"/>',
        dashed: '<line x1="5" y1="19" x2="19" y2="5" stroke-width="2" stroke-dasharray="4,3"/>',
        rect: '<rect x="4" y="4" width="16" height="16" stroke-width="2"/>',
        circle: '<circle cx="12" cy="12" r="8" stroke-width="2"/>',
        triangle: '<polygon points="12,4 4,20 20,20" stroke-width="2" fill="none"/>',
        star: '<polygon points="12,2 15,9 22,9 17,14 19,21 12,17 5,21 7,14 2,9 9,9" stroke-width="1.5" fill="none"/>'
      };
      shapeIcon.innerHTML = iconSvg[shape] || iconSvg.line;
    }

    setTool('shape');
  };

  window.setShapeColor = function(color) {
    shapeColor = color;
    document.querySelectorAll('#shape-dropdown .color-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === color);
    });
    const colorInput = document.getElementById('shape-color');
    if (colorInput) {
      colorInput.value = color.startsWith('#') ? color : '#000000';
    }
  };

  function setupDropdowns() {
    document.querySelectorAll('.tool-wrapper').forEach(wrapper => {
      const btn = wrapper.querySelector('.ftool-btn');
      const dropdown = wrapper.querySelector('.tool-dropdown');

      if (btn && dropdown) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isOpen = dropdown.classList.contains('open');
          const tool = btn.dataset.tool;
          const wasActive = btn.classList.contains('active');
          closeAllDropdowns();

          // Tool buttons (pen/eraser/highlighter): first click just
          // activates the tool; the dropdown only opens when the tool
          // is already active
          if (tool && !wasActive) {
            setTool(tool);
            return;
          }

          if (!isOpen) {
            dropdown.classList.add('open');
            positionDropdown(btn, dropdown);
          }
        });
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.tool-wrapper') && !e.target.closest('.overflow-menu') &&
          !e.target.closest('.overflow-menu-btn')) {
        closeAllDropdowns();
      }
    });
  }

  function positionDropdown(btn, dropdown) {
    const toolbar = document.getElementById('floating-toolbar');
    const isDockedLeft = toolbar.classList.contains('docked-left');
    const isDockedRight = toolbar.classList.contains('docked-right');

    if (isDockedLeft || isDockedRight) {
      const btnRect = btn.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();

      const topRelativeToToolbar = btnRect.top - toolbarRect.top;
      const leftRelativeToToolbar = toolbarRect.width + 8;
      const rightRelativeToToolbar = toolbarRect.width + 8;

      dropdown.style.cssText = `
        position: absolute !important;
        transform: none !important;
        margin: 0 !important;
        z-index: 1002 !important;
        top: ${topRelativeToToolbar}px !important;
        ${isDockedLeft
          ? `left: ${leftRelativeToToolbar}px !important; right: auto !important;`
          : `right: ${rightRelativeToToolbar}px !important; left: auto !important;`}
      `;

      requestAnimationFrame(() => {
        const dropdownRect = dropdown.getBoundingClientRect();

        if (dropdownRect.bottom > window.innerHeight - 10) {
          const currentTop = parseFloat(dropdown.style.top);
          const overflow = dropdownRect.bottom - (window.innerHeight - 10);
          dropdown.style.top = (currentTop - overflow) + 'px';
        }
        if (dropdownRect.top < 10) {
          const currentTop = parseFloat(dropdown.style.top);
          const underflow = 10 - dropdownRect.top;
          dropdown.style.top = (currentTop + underflow) + 'px';
        }
      });
    } else {
      dropdown.style.cssText = '';
    }
  }

  function closeAllDropdowns() {
    document.querySelectorAll('.tool-dropdown').forEach(d => {
      d.classList.remove('open');
      d.style.cssText = '';
    });
    closeOverflowMenu();
  }

  // ============= OVERFLOW MENU (PHONES) =============

  window.toggleOverflowMenu = function(event) {
    event.stopPropagation();
    const menu = document.getElementById('overflow-menu');
    if (!menu) return;
    const wasOpen = menu.classList.contains('show');
    closeAllDropdowns();
    if (!wasOpen) {
      menu.classList.add('show');
    }
  };

  window.closeOverflowMenu = function() {
    const menu = document.getElementById('overflow-menu');
    if (menu) menu.classList.remove('show');
  };

  // ============= SHAPE DRAWING =============

  function createShape(x, y, w, h) {
    const opts = {
      left: x,
      top: y,
      fill: 'transparent',
      stroke: shapeColor,
      strokeWidth: 2,
      originX: 'left',
      originY: 'top',
      hasControls: true,
      hasBorders: true,
      hasRotatingPoint: true,
      cornerSize: 10,
      transparentCorners: false,
      cornerColor: '#3b82f6',
      cornerStrokeColor: '#3b82f6',
      borderColor: '#3b82f6'
    };

    switch (currentShape) {
      case 'line':
        return new fabric.Line([x, y, x, y], {
          stroke: shapeColor,
          strokeWidth: 2,
          hasControls: true,
          hasBorders: true,
          cornerSize: 10,
          transparentCorners: false,
          cornerColor: '#3b82f6',
          borderColor: '#3b82f6'
        });
      case 'dashed':
        return new fabric.Line([x, y, x, y], {
          stroke: shapeColor,
          strokeWidth: 2,
          strokeDashArray: [8, 6],
          hasControls: true,
          hasBorders: true,
          cornerSize: 10,
          transparentCorners: false,
          cornerColor: '#3b82f6',
          borderColor: '#3b82f6'
        });
      case 'rect':
        return new fabric.Rect({ ...opts, width: 0, height: 0 });
      case 'circle':
        return new fabric.Ellipse({ ...opts, rx: 0, ry: 0 });
      case 'triangle':
        return new fabric.Triangle({ ...opts, width: 0, height: 0 });
      case 'star':
        return createStar(x, y, 0, opts);
    }
    return null;
  }

  function updateShapeSize(shape, startX, startY, width, height, canvas) {
    const absW = Math.abs(width);
    const absH = Math.abs(height);
    const left = width < 0 ? startX + width : startX;
    const top = height < 0 ? startY + height : startY;

    switch (currentShape) {
      case 'line':
      case 'dashed':
        shape.set({ x2: startX + width, y2: startY + height });
        shape.setCoords();
        break;
      case 'rect':
        shape.set({ left, top, width: absW, height: absH });
        shape.setCoords();
        break;
      case 'circle':
        shape.set({ left, top, rx: absW / 2, ry: absH / 2 });
        shape.setCoords();
        break;
      case 'triangle':
        shape.set({ left, top, width: absW, height: absH });
        shape.setCoords();
        break;
      case 'star':
        const radius = (absW + absH) / 4;
        canvas.remove(shape);
        tempShape = createStar(startX + width/2, startY + height/2, radius, {
          fill: 'transparent',
          stroke: shapeColor,
          strokeWidth: 2
        });
        tempShape.set({ selectable: false, evented: false });
        canvas.add(tempShape);
        break;
    }
  }

  function createStar(cx, cy, radius, opts) {
    if (radius < 1) radius = 1;
    const points = [];
    const spikes = 5;
    const outerRadius = radius;
    const innerRadius = radius / 2;

    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? outerRadius : innerRadius;
      const angle = (Math.PI / spikes) * i - Math.PI / 2;
      points.push({
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r
      });
    }

    return new fabric.Polygon(points, {
      ...opts,
      hasControls: true,
      hasBorders: true,
      hasRotatingPoint: true,
      cornerSize: 10,
      transparentCorners: false,
      cornerColor: '#3b82f6',
      cornerStrokeColor: '#3b82f6',
      borderColor: '#3b82f6'
    });
  }

  // ============= FLOATING TOOLBAR =============

  function setupToolbarDrag() {
    const toolbar = document.getElementById('floating-toolbar');
    const handle = document.getElementById('toolbar-drag-handle');
    if (!toolbar || !handle) return;

    let isDragging = false;
    let startX, startY, initialX, initialY;

    // Pointer events cover mouse, finger, and stylus (S Pen) with one
    // code path; pointer capture keeps the gesture on the handle even
    // when it leaves the element
    handle.addEventListener('pointerdown', startDrag);

    function clearDockedClasses() {
      toolbar.classList.remove('docked-left', 'docked-right', 'docked-top', 'docked-bottom');
    }

    function startDrag(e) {
      isDragging = true;
      toolbar.style.transition = 'none';

      startX = e.clientX;
      startY = e.clientY;

      const rect = toolbar.getBoundingClientRect();
      initialX = rect.left;
      initialY = rect.top;

      clearDockedClasses();
      toolbar.style.transform = 'none';
      toolbar.style.left = initialX + 'px';
      toolbar.style.top = initialY + 'px';
      toolbar.style.right = 'auto';
      toolbar.style.bottom = 'auto';

      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      handle.addEventListener('pointermove', drag);
      handle.addEventListener('pointerup', stopDrag);
      handle.addEventListener('pointercancel', stopDrag);

      e.preventDefault();
    }

    function drag(e) {
      if (!isDragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newX = initialX + dx;
      let newY = initialY + dy;

      const maxX = window.innerWidth - 50;
      const maxY = window.innerHeight - 50;
      // Keep the toolbar below the iOS status bar in standalone mode
      const safeTop = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--safe-area-top')
      ) || 0;
      newX = Math.max(-20, Math.min(newX, maxX));
      newY = Math.max(safeTop, Math.min(newY, maxY));

      toolbar.style.left = newX + 'px';
      toolbar.style.top = newY + 'px';
      toolbar.style.right = 'auto';
      toolbar.style.bottom = 'auto';
    }

    function stopDrag(e) {
      isDragging = false;
      handle.removeEventListener('pointermove', drag);
      handle.removeEventListener('pointerup', stopDrag);
      handle.removeEventListener('pointercancel', stopDrag);
      try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }

      const rect = toolbar.getBoundingClientRect();
      const viewWidth = window.innerWidth;
      const viewHeight = window.innerHeight;

      const handleY = rect.top + rect.height / 2;
      const handleX = rect.left + rect.width / 2;

      // Zones measured from the safe-area line - the drag clamp stops the
      // toolbar there, so the top zone must start there too
      const safeTop = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--safe-area-top')
      ) || 0;
      const topZoneHeight = safeTop + rect.height;
      const bottomZoneHeight = rect.height * 3;

      toolbar.style.transition = 'all 0.2s ease-out';

      closeAllDropdowns();

      if (handleY < topZoneHeight) {
        clearDockedClasses();
        toolbar.classList.add('docked-top');
        toolbar.style.top = ''; // CSS places it below the status bar
        toolbar.style.left = '50%';
        toolbar.style.right = 'auto';
        toolbar.style.bottom = 'auto';
        toolbar.style.transform = 'translateX(-50%)';
      } else if (handleY > viewHeight - bottomZoneHeight) {
        clearDockedClasses();
        toolbar.classList.add('docked-bottom');
        toolbar.style.bottom = '0';
        toolbar.style.top = 'auto';
        toolbar.style.left = '50%';
        toolbar.style.right = 'auto';
        toolbar.style.transform = 'translateX(-50%)';
      } else if (handleX < viewWidth / 2) {
        clearDockedClasses();
        toolbar.classList.add('docked-left');
        toolbar.style.left = '0';
        toolbar.style.top = '50%';
        toolbar.style.right = 'auto';
        toolbar.style.bottom = 'auto';
        toolbar.style.transform = 'translateY(-50%)';
      } else {
        clearDockedClasses();
        toolbar.classList.add('docked-right');
        toolbar.style.right = '0';
        toolbar.style.left = 'auto';
        toolbar.style.top = '50%';
        toolbar.style.bottom = 'auto';
        toolbar.style.transform = 'translateY(-50%)';
      }
    }
  }

  window.toggleToolbarCollapse = function() {
    const toolbar = document.getElementById('floating-toolbar');
    const btn = toolbar.querySelector('.toolbar-collapse-btn');
    if (toolbar) {
      toolbar.classList.toggle('collapsed');
      if (btn) {
        btn.textContent = toolbar.classList.contains('collapsed') ? '+' : '-';
      }
    }
  };

  // ============= EVENT LISTENERS =============

  function setupEventListeners() {
    const viewer = document.getElementById('canvas-viewer');

    // Close dropdowns when user starts interacting with canvas
    viewer.addEventListener('mousedown', () => closeAllDropdowns());
    viewer.addEventListener('touchstart', () => closeAllDropdowns(), { passive: true });

    function startPan(e) {
      if (currentTool !== 'pan') return;
      if (stylusActive) return;

      isPanning = true;
      viewer.style.cursor = 'grabbing';

      if (e.type === 'touchstart') {
        if (e.touches.length !== 1) return;
        panStartX = e.touches[0].clientX;
        panStartY = e.touches[0].clientY;
      } else {
        panStartX = e.clientX;
        panStartY = e.clientY;
      }

      panScrollLeft = viewer.scrollLeft;
      panScrollTop = viewer.scrollTop;

      e.preventDefault();
    }

    function doPan(e) {
      if (!isPanning || currentTool !== 'pan') return;

      let clientX, clientY;
      if (e.type === 'touchmove') {
        if (e.touches.length !== 1) return;
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }

      const dx = clientX - panStartX;
      const dy = clientY - panStartY;

      viewer.scrollLeft = panScrollLeft - dx;
      viewer.scrollTop = panScrollTop - dy;

      e.preventDefault();
    }

    function endPan() {
      if (isPanning) {
        isPanning = false;
        viewer.style.cursor = '';
      }
    }

    viewer.addEventListener('mousedown', startPan);
    document.addEventListener('mousemove', doPan);
    document.addEventListener('mouseup', endPan);

    viewer.addEventListener('touchstart', e => {
      if (currentTool === 'pan' && e.touches.length === 1) {
        startPan(e);
      }
    }, { passive: false });

    viewer.addEventListener('touchmove', e => {
      if (currentTool === 'pan' && isPanning && e.touches.length === 1) {
        doPan(e);
      }
    }, { passive: false });

    viewer.addEventListener('touchend', endPan);
    viewer.addEventListener('touchcancel', endPan);

    // Palm rejection
    function setStylusActive(active) {
      stylusActive = active;
    }

    // Track stylus on all page containers. S Pen and hover-capable
    // Apple Pencils report hover moves (buttons 0) whenever the pen is
    // near the screen: treat hover as "stylus present" with a rolling
    // release timer, so palm rejection engages before the tip lands and
    // - crucially - releases after the pen leaves. Merely clearing the
    // timer here used to leave stylusActive stuck on after the lift-off
    // hover, permanently blocking finger scrolling.
    pagesWrapper.addEventListener('pointermove', e => {
      if (e.pointerType === 'pen') {
        if (stylusTimeout) {
          clearTimeout(stylusTimeout);
          stylusTimeout = null;
        }
        if (e.buttons === 0) {
          setStylusActive(true);
          stylusTimeout = setTimeout(() => {
            setStylusActive(false);
          }, STYLUS_TIMEOUT_MS);
        }
      }
    }, { passive: true });

    pagesWrapper.addEventListener('pointerdown', e => {
      if (!e.target.classList.contains('upper-canvas')) return;

      // Apple Pencil detection: pointerType 'pen' OR touch with high pressure
      const isPen = e.pointerType === 'pen' || (e.pointerType === 'touch' && e.pressure > 0 && e.pressure !== 0.5);

      if (isPen) {
        setStylusActive(true);
        if (stylusTimeout) {
          clearTimeout(stylusTimeout);
          stylusTimeout = null;
        }
        e.target.setPointerCapture(e.pointerId);
      } else if (e.pointerType === 'touch') {
        if (stylusActive || palmRejectionOn) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }, { passive: false });

    pagesWrapper.addEventListener('pointerup', e => {
      const isPen = e.pointerType === 'pen' || (e.pointerType === 'touch' && e.pressure > 0 && e.pressure !== 0.5);
      if (isPen) {
        stylusTimeout = setTimeout(() => {
          setStylusActive(false);
        }, STYLUS_TIMEOUT_MS);
      }
    });

    pagesWrapper.addEventListener('pointercancel', e => {
      const isPen = e.pointerType === 'pen' || (e.pointerType === 'touch' && e.pressure > 0 && e.pressure !== 0.5);
      if (isPen) {
        stylusTimeout = setTimeout(() => {
          setStylusActive(false);
        }, STYLUS_TIMEOUT_MS);
      }
    });

    // Pinch-to-zoom
    function getTouchDistance(touch1, touch2) {
      const dx = touch1.clientX - touch2.clientX;
      const dy = touch1.clientY - touch2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function handleTouchStart(e) {
      // Stylus on or near the page: no new touch gesture may start. This
      // also swallows the stylus's own compatibility touches - Android
      // reports them as plain touches (touchType is iOS-only), and
      // tracking one next to a resting palm used to read as a two-finger
      // pinch that zoomed the page mid-stroke
      if (stylusActive) {
        e.preventDefault();
        return;
      }

      for (const touch of e.changedTouches) {
        // Apple Pencil compatibility touches identify themselves on iOS -
        // only track finger touches here
        if (touch.touchType === 'stylus') continue;
        activeTouches.set(touch.identifier, touch);
      }

      if (activeTouches.size === 1) {
        if (palmRejectionOn) {
          // Palm mode: one finger scrolls the page
          const t = Array.from(activeTouches.values())[0];
          touchScrollLast = { x: t.clientX, y: t.clientY };
          e.preventDefault();
          return;
        }
      }

      if (activeTouches.size === 2) {
        touchScrollLast = null;
        const touches = Array.from(activeTouches.values());
        initialPinchDistance = getTouchDistance(touches[0], touches[1]);
        initialZoomLevel = zoomLevel;
        isPinching = true;

        pinchCenterX = (touches[0].clientX + touches[1].clientX) / 2;
        pinchCenterY = (touches[0].clientY + touches[1].clientY) / 2;

        Object.values(fabricCanvases).forEach(canvas => {
          canvas.isDrawingMode = false;
        });
        e.preventDefault();
      } else if (activeTouches.size === 1 && e.target.classList.contains('upper-canvas')) {
        e.preventDefault();
      }
    }

    function handleTouchMove(e) {
      for (const touch of e.changedTouches) {
        if (activeTouches.has(touch.identifier)) {
          activeTouches.set(touch.identifier, touch);
        }
      }

      if (activeTouches.size === 1) {
        if (stylusActive) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (palmRejectionOn && !isPinching) {
          // Palm mode: one finger scrolls the page
          const t = Array.from(activeTouches.values())[0];
          if (touchScrollLast) {
            viewer.scrollLeft -= t.clientX - touchScrollLast.x;
            viewer.scrollTop -= t.clientY - touchScrollLast.y;
          }
          touchScrollLast = { x: t.clientX, y: t.clientY };
          e.preventDefault();
          return;
        }
      }

      if (isPinching && activeTouches.size === 2) {
        const now = Date.now();
        if (now - lastPinchZoomTime < PINCH_THROTTLE_MS) {
          e.preventDefault();
          return;
        }
        lastPinchZoomTime = now;

        const touches = Array.from(activeTouches.values());
        const currentDistance = getTouchDistance(touches[0], touches[1]);
        const scale = currentDistance / initialPinchDistance;

        let newZoom = initialZoomLevel * scale;
        // Zoom is fit-width-relative; 3x fit matches the old on-screen
        // maximum on iPad now that ink fitScale is applied (memory is
        // governed by MAX_RES_SCALE, not the display zoom)
        const maxZoom = 3.0;
        newZoom = Math.max(0.5, Math.min(maxZoom, newZoom));

        const zoomThreshold = isIOSSafari ? 0.03 : 0.01;
        if (Math.abs(newZoom - zoomLevel) > zoomThreshold) {
          const viewerRect = viewer.getBoundingClientRect();
          const currentPinchX = (touches[0].clientX + touches[1].clientX) / 2;
          const currentPinchY = (touches[0].clientY + touches[1].clientY) / 2;

          const oldScale = fitScale * zoomLevel;
          const newScale = fitScale * newZoom;

          const pdfX = (viewer.scrollLeft + pinchCenterX - viewerRect.left) / oldScale;
          const pdfY = (viewer.scrollTop + pinchCenterY - viewerRect.top) / oldScale;

          zoomLevel = newZoom;
          applyZoomToAllPages();
          updateZoomDisplay();

          const newScrollLeft = (pdfX * newScale) - (currentPinchX - viewerRect.left);
          const newScrollTop = (pdfY * newScale) - (currentPinchY - viewerRect.top);

          viewer.scrollLeft = Math.max(0, newScrollLeft);
          viewer.scrollTop = Math.max(0, newScrollTop);

          pinchCenterX = currentPinchX;
          pinchCenterY = currentPinchY;
        }
        e.preventDefault();
      } else if (activeTouches.size === 1 && e.target.classList.contains('upper-canvas')) {
        e.preventDefault();
      }
    }

    function handleTouchEnd(e) {
      for (const touch of e.changedTouches) {
        activeTouches.delete(touch.identifier);
      }

      if (activeTouches.size === 0) {
        touchScrollLast = null;
      }

      if (activeTouches.size < 2 && isPinching) {
        isPinching = false;

        setTimeout(() => {
          if (!isPinching) {
            Object.values(fabricCanvases).forEach(canvas => {
              applyToolSettings(canvas);
            });
            scheduleResolutionUpdate();
          }
        }, 100);
      }
    }

    viewer.addEventListener('touchstart', handleTouchStart, { passive: false });
    viewer.addEventListener('touchmove', handleTouchMove, { passive: false });
    viewer.addEventListener('touchend', handleTouchEnd, { passive: false });
    viewer.addEventListener('touchcancel', handleTouchEnd, { passive: false });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectionCanvas) {
        e.preventDefault();
        deleteSelection();
      }
    });

    // Autosave
    setInterval(saveState, 30000);
    window.addEventListener('beforeunload', saveState);
    window.addEventListener('beforeunload', saveScrollPosition);
    // iOS standalone apps don't reliably fire beforeunload - save on hide too
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveScrollPosition();
    });
  }

  // ============= ZOOM CONTROLS =============

  window.zoomIn = function() {
    if (zoomLevel < 3.0) {
      zoomLevel = Math.min(zoomLevel + 0.25, 3.0);
      applyZoomToAllPages();
      updateZoomDisplay();
      scheduleResolutionUpdate();
    }
  };

  window.zoomOut = function() {
    if (zoomLevel > 0.5) {
      zoomLevel = Math.max(zoomLevel - 0.25, 0.5);
      applyZoomToAllPages();
      updateZoomDisplay();
      scheduleResolutionUpdate();
    }
  };

  window.zoomFit = function() {
    zoomLevel = 1.0;
    applyZoomToAllPages();
    updateZoomDisplay();
    scheduleResolutionUpdate();
  };

  // ============= DYNAMIC CANVAS RESOLUTION =============
  // Zoom is applied as a CSS transform, which blurs the fixed-resolution
  // backing store. After zooming (or scrolling to new pages), the pages
  // near the viewport get their backing store re-rendered at the zoom
  // factor (capped) so ink stays crisp. Object coordinates are unchanged -
  // fabric's setZoom handles the mapping.
  // High-DPI phones (dpr ~3) already pay renderScale x dpr in display
  // cost - a 3x backing store on top exceeds Chrome's canvas limits
  const MAX_RES_SCALE = (isIOSSafari || (window.devicePixelRatio || 1) > 2) ? 2 : 3;
  let resolutionTimer = null;

  function pageResScale(pageNum) {
    const canvas = fabricCanvases[pageNum];
    return (canvas && canvas.__resScale) || 1;
  }

  function scheduleResolutionUpdate() {
    clearTimeout(resolutionTimer);
    resolutionTimer = setTimeout(updateCanvasResolutions, 350);
  }

  function updateCanvasResolutions() {
    let changed = false;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const canvas = fabricCanvases[pageNum];
      if (!canvas) continue;

      // Only pages near the viewport carry a high-res backing store,
      // bounding memory use regardless of note length. iOS Safari has a
      // tight canvas memory budget - upgrade the current page only there.
      const nearWindow = isIOSSafari ? 0 : 1;
      const near = Math.abs(pageNum - currentPage) <= nearWindow;
      const target = near ? Math.min(Math.max(zoomLevel, 1), MAX_RES_SCALE) : 1;
      const current = canvas.__resScale || 1;

      if (Math.abs(target - current) < 0.25) continue;
      setCanvasResolution(pageNum, target);
      changed = true;
    }

    if (changed) {
      applyZoomToAllPages();
    }
  }

  function setCanvasResolution(pageNum, scale) {
    const canvas = fabricCanvases[pageNum];
    const container = pageContainers[pageNum];
    if (!canvas || !container) return;

    const w = Math.round(canvas.__baseWidth * scale);
    const h = Math.round(canvas.__baseHeight * scale);

    canvas.__resScale = scale;
    canvas.setDimensions({ width: w, height: h });
    canvas.setZoom(scale);
    canvas.calcOffset();

    container.style.width = w + 'px';
    container.style.height = h + 'px';

    // Keep a PDF background canvas aligned (bitmap CSS-scaled; the ink
    // above it is what gets the true resolution boost)
    const pdfCanvas = container.querySelector('.pdf-canvas');
    if (pdfCanvas) {
      pdfCanvas.style.width = w + 'px';
      pdfCanvas.style.height = h + 'px';
    }

    canvas.requestRenderAll();
  }

  function applyZoomToPage(pageNum) {
    const actualScale = fitScale * zoomLevel;
    const container = pageContainers[pageNum];
    if (container) {
      // The backing store already carries resScale - CSS covers the rest
      container.style.transform = 'scale(' + (actualScale / pageResScale(pageNum)) + ')';
      container.style.transformOrigin = 'top left';
    }
  }

  function applyZoomToAllPages() {
    const actualScale = fitScale * zoomLevel;
    const viewer = document.getElementById('canvas-viewer');

    Object.keys(pageContainers).forEach(k => applyZoomToPage(parseInt(k)));

    const firstCanvas = fabricCanvases[1];
    if (pageContainers[1] && firstCanvas) {
      const baseW = firstCanvas.__baseWidth || firstCanvas.width;
      const baseH = firstCanvas.__baseHeight || firstCanvas.height;
      const scaledWidth = baseW * actualScale;
      const scaledHeight = baseH * actualScale;

      const viewerWidth = viewer.clientWidth;
      const leftPadding = Math.max(16, (viewerWidth - scaledWidth) / 2);
      pagesWrapper.style.paddingLeft = leftPadding + 'px';
      pagesWrapper.style.paddingRight = '16px';

      Object.keys(pageContainers).forEach(k => {
        const pageNum = parseInt(k);
        const container = pageContainers[pageNum];
        const res = pageResScale(pageNum);
        container.style.marginBottom = ((scaledHeight - baseH * res) + 20) + 'px';
        container.style.marginRight = Math.max(0, scaledWidth - baseW * res) + 'px';
      });
    }
  }

  function updateZoomDisplay() {
    const zoomDisplay = document.getElementById('zoom-display');
    if (zoomDisplay) {
      zoomDisplay.textContent = Math.round(zoomLevel * 100) + '%';
    }
  }

  // ============= PAGE NAVIGATION =============

  function updatePageInfo() {
    if (pageInfo) {
      if (totalPages > 1 || MODE === 'pdf') {
        pageInfo.textContent = 'Page ' + currentPage + ' of ' + totalPages;
      } else {
        pageInfo.textContent = '';
      }
    }
  }

  // ============= UNDO / REDO =============

  window.undo = function() {
    const stack = undoStacks[currentPage];
    const canvas = fabricCanvases[currentPage];

    // The bottom entry is the baseline (state when the note was opened
    // or the page created) - it is never popped
    if (stack && stack.length > 1 && canvas) {
      const currentState = stack.pop();
      redoStacks[currentPage].push(currentState);

      const prevState = stack[stack.length - 1];
      isRestoringState = true;
      canvas.loadFromJSON(prevState, () => {
        isRestoringState = false;
        markEraserPaths(canvas);
        canvas.requestRenderAll();
        updateUndoRedoButtons();
        scheduleThumbRefresh(currentPage);
      });
    }
  };

  window.redo = function() {
    const stack = redoStacks[currentPage];
    const canvas = fabricCanvases[currentPage];

    if (stack && stack.length > 0 && canvas) {
      const nextState = stack.pop();
      undoStacks[currentPage].push(nextState);

      isRestoringState = true;
      canvas.loadFromJSON(nextState, () => {
        isRestoringState = false;
        markEraserPaths(canvas);
        canvas.requestRenderAll();
        updateUndoRedoButtons();
        scheduleThumbRefresh(currentPage);
      });
    }
  };

  function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');

    if (undoBtn) {
      // Bottom entry is the baseline - undo is possible above it only
      undoBtn.disabled = !undoStacks[currentPage] || undoStacks[currentPage].length <= 1;
    }
    if (redoBtn) {
      redoBtn.disabled = !redoStacks[currentPage] || redoStacks[currentPage].length === 0;
    }
  }

  window.clearPage = function() {
    if (confirm('Clear all annotations on this page?')) {
      const canvas = fabricCanvases[currentPage];
      if (canvas) {
        saveToUndoStack(currentPage);
        canvas.clear();
        redoStacks[currentPage] = [];
        updateUndoRedoButtons();
      }
    }
  };

  // ============= STATE SAVE/RESTORE =============

  function getStateKey() {
    return 'annotator-state-' + NOTE_ID;
  }

  function saveState() {
    try {
      Object.keys(fabricCanvases).forEach(pageNum => {
        canvasStates[pageNum] = canvasToJSON(fabricCanvases[pageNum]);
      });

      const hasAnnotations = Object.values(canvasStates).some(state =>
        state && state.objects && state.objects.length > 0
      );

      if (hasAnnotations || totalPages > 1 || backgroundTemplate !== 'blank') {
        localStorage.setItem(getStateKey(), JSON.stringify({
          canvasStates: canvasStates,
          currentPage: currentPage,
          totalPages: MODE === 'ink' ? totalPages : undefined,
          backgroundTemplate: MODE === 'ink' ? backgroundTemplate : undefined,
          savedAt: new Date().toISOString()
        }));
      }
    } catch (e) {
      console.warn('Could not save state:', e);
    }
  }

  async function restoreState() {
    try {
      // First try to get from server
      const response = await fetch('/note/' + NOTE_ID + '/canvas');
      const result = await response.json();

      if (result.canvasStates) {
        Object.assign(canvasStates, result.canvasStates);
        if (result.currentPage) currentPage = result.currentPage;
        if (MODE === 'ink' && result.backgroundTemplate) {
          backgroundTemplate = result.backgroundTemplate;
        }
        // Restore totalPages for ink mode
        if (MODE === 'ink' && result.totalPages) {
          totalPages = result.totalPages;
        } else if (MODE === 'ink') {
          // Infer totalPages from canvasStates keys
          const pageNums = Object.keys(result.canvasStates).map(k => parseInt(k)).filter(n => !isNaN(n));
          if (pageNums.length > 0) {
            totalPages = Math.max(...pageNums);
          }
        }
        return;
      }

      // Fall back to localStorage
      const saved = localStorage.getItem(getStateKey());
      if (saved) {
        const data = JSON.parse(saved);
        if (data.canvasStates) {
          Object.assign(canvasStates, data.canvasStates);
          if (data.currentPage) currentPage = data.currentPage;
          if (MODE === 'ink' && data.backgroundTemplate) {
            backgroundTemplate = data.backgroundTemplate;
          }
          // Restore totalPages for ink mode
          if (MODE === 'ink' && data.totalPages) {
            totalPages = data.totalPages;
          } else if (MODE === 'ink') {
            const pageNums = Object.keys(data.canvasStates).map(k => parseInt(k)).filter(n => !isNaN(n));
            if (pageNums.length > 0) {
              totalPages = Math.max(...pageNums);
            }
          }
        }
      }
    } catch (e) {
      console.warn('Could not restore state:', e);
    }
  }

  // ============= SAVE & EXIT =============

  window.saveAnnotations = async function() {
    try {
      Object.keys(fabricCanvases).forEach(pageNum => {
        canvasStates[pageNum] = canvasToJSON(fabricCanvases[pageNum]);
      });

      const response = await fetch('/note/' + NOTE_ID + '/canvas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canvasStates: canvasStates,
          currentPage: currentPage,
          totalPages: MODE === 'ink' ? totalPages : undefined,
          backgroundTemplate: MODE === 'ink' ? backgroundTemplate : undefined
        })
      });

      // Handle session expiration
      if (response.status === 401) {
        alert('Session expired. Please log in again.');
        window.location.href = '/login';
        return false;
      }

      const result = await response.json();

      if (result.success) {
        localStorage.removeItem(getStateKey());
        return true;
      } else {
        throw new Error(result.error || 'Save failed');
      }
    } catch (error) {
      console.error('Save error:', error);
      alert('Failed to save: ' + error.message);
      return false;
    }
  };

  window.saveAndContinue = async function() {
    const btn = document.querySelector('.save-dropdown-item');
    if (btn) {
      btn.classList.add('saving');
      btn.innerHTML = '<span>Saving...</span>';
    }

    const success = await saveAnnotations();

    if (btn) {
      btn.classList.remove('saving');
      btn.innerHTML = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"/></svg><span>Save</span>';
    }

    if (success) {
      closeSaveDropdown();
    }
  };

  window.saveAndExit = async function() {
    const success = await saveAnnotations();
    if (success) {
      window.location.href = '/';
    }
  };

  window.exitWithoutSaving = function() {
    closeSaveDropdown();
    document.getElementById('exit-confirm-modal')?.classList.remove('hidden');
  };

  window.cancelExitWithoutSaving = function() {
    document.getElementById('exit-confirm-modal')?.classList.add('hidden');
  };

  window.confirmExitWithoutSaving = function() {
    window.location.href = '/';
  };

  window.toggleSaveDropdown = function(e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('save-dropdown');
    if (dropdown) {
      const opening = !dropdown.classList.contains('open');
      dropdown.classList.toggle('open');
      if (opening) {
        // Track the save button beside a side-docked toolbar,
        // same as the tool dropdowns
        positionDropdown(document.getElementById('save-btn'), dropdown);
      } else {
        dropdown.style.cssText = '';
      }
    }
  };

  function closeSaveDropdown() {
    const dropdown = document.getElementById('save-dropdown');
    if (dropdown) {
      dropdown.classList.remove('open');
      dropdown.style.cssText = '';
    }
  }

  // Close save dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.tool-wrapper')) {
      closeSaveDropdown();
    }
  });

  // ============= AUDIO RECORDING =============

  let mediaRecorder = null;
  let audioStream = null;
  let currentMimeType = 'audio/webm';
  let audioChunks = [];
  let recordingStartTime = null;
  let recordingInterval = null;
  let transcriptionInterval = null;
  let isRecording = false;
  let fullTranscript = '';

  window.toggleAudioPanel = function() {
    const panel = document.getElementById('audio-panel');
    const audioBtn = document.getElementById('tool-audio');
    const container = document.querySelector('.annotator-container');

    if (panel) {
      panel.classList.toggle('hidden');
      audioBtn?.classList.toggle('audio-active', !panel.classList.contains('hidden'));
      container?.classList.toggle('audio-panel-open', !panel.classList.contains('hidden'));

      // Load existing transcript when opening
      if (!panel.classList.contains('hidden')) {
        loadTranscript();
      }
    }
  };

  window.toggleAudioCollapse = function() {
    const panel = document.getElementById('audio-panel');
    const container = document.querySelector('.annotator-container');
    const fab = document.getElementById('audio-mini-fab');

    if (panel) {
      const isCollapsed = panel.classList.toggle('collapsed');
      container?.classList.toggle('audio-panel-collapsed', isCollapsed);

      // Show/hide FAB
      if (fab) {
        fab.classList.toggle('visible', isCollapsed);
      }
    }
  };

  window.toggleAudioSection = function(section) {
    const container = document.getElementById(
      section === 'summary' ? 'audio-summary-container' : 'audio-transcript-container'
    );
    container?.classList.toggle('collapsed');
  };

  // Render summary text as a bulleted list, one bullet per line
  function displaySummary(summary) {
    const summaryContainer = document.getElementById('audio-summary-container');
    const summaryEl = document.getElementById('audio-summary');
    if (!summaryContainer || !summaryEl) return;

    const escapeHtml = (s) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const items = summary
      .split('\n')
      .map(line => line.replace(/^\s*[-•*]\s*/, '').trim())
      .filter(Boolean);

    summaryEl.innerHTML = '<ul>' + items.map(i => '<li>' + escapeHtml(i) + '</li>').join('') + '</ul>';
    summaryContainer.classList.remove('hidden');
    summaryContainer.classList.remove('collapsed');
  }

  async function loadTranscript() {
    try {
      const response = await fetch('/note/' + NOTE_ID + '/transcript');
      const result = await response.json();

      if (result.transcript) {
        fullTranscript = result.transcript;
        updateTranscriptDisplay();
      }

      if (result.summary) {
        displaySummary(result.summary);
      }
    } catch (e) {
      console.warn('Could not load transcript:', e);
    }
  }

  function updateTranscriptDisplay() {
    const transcriptEl = document.getElementById('audio-transcript');
    const summarizeBtn = document.getElementById('summarize-btn');

    if (transcriptEl) {
      if (fullTranscript) {
        // Render each paragraph (split on blank lines) as its own <p>
        transcriptEl.innerHTML = fullTranscript
          .split(/\n{2,}/)
          .filter(p => p.trim())
          .map(p => '<p>' + p + '</p>')
          .join('');
      } else {
        transcriptEl.innerHTML = '<p class="transcript-placeholder">Recording transcript will appear here...</p>';
      }
    }

    if (summarizeBtn) {
      summarizeBtn.disabled = !fullTranscript || !OPENAI_CONFIGURED;
    }
  }

  window.toggleRecording = async function() {
    if (isRecording) {
      stopRecording();
    } else {
      await startRecording();
    }
  };

  async function startRecording() {
    // Check for HTTPS (required for microphone access except on localhost)
    const isSecure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!isSecure) {
      alert('Microphone access requires HTTPS. Please access this site via HTTPS.');
      return;
    }

    // Check if getUserMedia is available
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Your browser does not support audio recording.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Detect best audio format - Safari needs mp4, others prefer webm
      let mimeType = 'audio/webm';
      const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

      if (isSafari || MediaRecorder.isTypeSupported('audio/mp4')) {
        // Safari/iOS: use mp4 (produces valid files)
        if (MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/mp4';
        } else if (MediaRecorder.isTypeSupported('audio/aac')) {
          mimeType = 'audio/aac';
        } else if (MediaRecorder.isTypeSupported('audio/mpeg')) {
          mimeType = 'audio/mpeg';
        }
      } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      }

      console.log('Recording with mimeType:', mimeType);
      currentMimeType = mimeType;
      audioStream = stream;
      isRecording = true;
      startRecorderSegment();
      recordingStartTime = Date.now();

      // Update UI
      const recordBtn = document.getElementById('audio-record-btn');
      const recordIcon = document.getElementById('audio-record-icon');
      const statusText = document.getElementById('audio-status-text');
      const durationEl = document.getElementById('audio-duration');
      const fab = document.getElementById('audio-mini-fab');
      const fabIcon = document.getElementById('audio-fab-icon');
      const fabDuration = document.getElementById('audio-fab-duration');

      recordBtn?.classList.add('recording');
      fab?.classList.add('recording');
      if (recordIcon) {
        recordIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2"/>';
      }
      if (fabIcon) {
        fabIcon.innerHTML = '<rect x="7" y="7" width="10" height="10" rx="2"/>';
      }
      if (statusText) statusText.textContent = 'Recording...';
      durationEl?.classList.remove('hidden');
      if (fabDuration) fabDuration.style.display = 'block';

      // Update duration display
      recordingInterval = setInterval(updateDuration, 1000);

      // Every 10 seconds, rotate the recorder so each segment is a complete
      // standalone file (chunks sliced from one continuous recording lack
      // container headers after the first, and ffmpeg rejects them)
      transcriptionInterval = setInterval(() => {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          mediaRecorder.stop(); // onstop sends the segment and starts a new one
        }
      }, 10000);

    } catch (err) {
      console.error('Failed to start recording:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        alert('Microphone permission denied. Please allow microphone access in your browser settings and reload the page.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        alert('No microphone found. Please connect a microphone and try again.');
      } else {
        alert('Could not access microphone: ' + err.message);
      }
    }
  }

  // Start a fresh MediaRecorder segment on the live stream. Each segment
  // produces a complete file with headers, sent for transcription on stop.
  function startRecorderSegment() {
    audioChunks = [];
    mediaRecorder = new MediaRecorder(audioStream, { mimeType: currentMimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      const sendPromise = audioChunks.length > 0 ? sendForTranscription() : Promise.resolve();

      if (isRecording) {
        // Segment rotation - keep recording on the same stream
        startRecorderSegment();
      } else {
        // Final segment - release the microphone
        audioStream?.getTracks().forEach(track => track.stop());
        audioStream = null;
        const statusText = document.getElementById('audio-status-text');
        if (statusText) statusText.textContent = 'Transcribing...';
        sendPromise.then(() => {
          const el = document.getElementById('audio-status-text');
          if (el) el.textContent = 'Tap to record';
        });
      }
    };

    mediaRecorder.start();
  }

  function stopRecording() {
    clearInterval(recordingInterval);
    clearInterval(transcriptionInterval);
    isRecording = false;

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop(); // onstop sends the final segment and releases the mic
    }

    // Update UI
    const recordBtn = document.getElementById('audio-record-btn');
    const recordIcon = document.getElementById('audio-record-icon');
    const statusText = document.getElementById('audio-status-text');
    const fab = document.getElementById('audio-mini-fab');
    const fabIcon = document.getElementById('audio-fab-icon');
    const fabDuration = document.getElementById('audio-fab-duration');

    recordBtn?.classList.remove('recording');
    fab?.classList.remove('recording');
    if (recordIcon) {
      recordIcon.innerHTML = '<circle cx="12" cy="12" r="10"/>';
    }
    if (fabIcon) {
      fabIcon.innerHTML = '<circle cx="12" cy="12" r="10"/>';
    }
    if (statusText) statusText.textContent = 'Tap to record';
    if (fabDuration) fabDuration.style.display = 'none';
  }

  function updateDuration() {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');
    const timeStr = mins + ':' + secs;

    const durationEl = document.getElementById('audio-duration');
    const fabDuration = document.getElementById('audio-fab-duration');
    if (durationEl) {
      durationEl.textContent = timeStr;
    }
    if (fabDuration) {
      fabDuration.textContent = timeStr;
    }
  }

  async function sendForTranscription() {
    if (audioChunks.length === 0) return;

    const blob = new Blob(audioChunks, { type: currentMimeType });
    audioChunks = []; // Clear for next batch

    // Determine file extension from mimeType
    let ext = 'webm';
    if (currentMimeType.includes('mp4') || currentMimeType.includes('m4a')) {
      ext = 'mp4';
    } else if (currentMimeType.includes('mp3') || currentMimeType.includes('mpeg')) {
      ext = 'mp3';
    } else if (currentMimeType.includes('aac')) {
      ext = 'm4a';
    } else if (currentMimeType.includes('ogg')) {
      ext = 'ogg';
    }

    const formData = new FormData();
    formData.append('audio', blob, 'recording.' + ext);

    try {
      const response = await fetch('/note/' + NOTE_ID + '/transcribe', {
        method: 'POST',
        body: formData
      });

      if (response.status === 401) {
        alert('Session expired. Please log in again.');
        window.location.href = '/login';
        return;
      }

      const result = await response.json();

      if (result.text) {
        // Match server append logic: paragraph break if the chunk began after a pause
        const separator = fullTranscript ? (result.leadingPause ? '\n\n' : ' ') : '';
        fullTranscript += separator + result.text;
        updateTranscriptDisplay();
      }
    } catch (err) {
      console.error('Transcription failed:', err);
    }
  }

  window.summarizeTranscript = async function() {
    const summarizeBtn = document.getElementById('summarize-btn');
    if (summarizeBtn) {
      summarizeBtn.disabled = true;
      summarizeBtn.textContent = 'Summarising...';
    }

    try {
      const response = await fetch('/note/' + NOTE_ID + '/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.status === 401) {
        alert('Session expired. Please log in again.');
        window.location.href = '/login';
        return;
      }

      const result = await response.json();

      if (result.summary) {
        displaySummary(result.summary);
      } else if (result.error) {
        alert('Summarisation failed: ' + result.error);
      }
    } catch (err) {
      console.error('Summarisation failed:', err);
      alert('Summarisation failed: ' + err.message);
    } finally {
      if (summarizeBtn) {
        summarizeBtn.disabled = false;
        summarizeBtn.textContent = 'Summarise';
      }
    }
  };

  // ============= START =============
  init();

})();
