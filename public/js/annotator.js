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
  let strokeColor = '#000000';
  let strokeWidth = 4;
  let highlighterColor = 'rgba(255,255,0,0.4)';
  let highlighterWidth = 20;
  let currentShape = 'line';
  let shapeColor = '#000000';
  let eraserMode = 'eraser';

  // Shape drawing state
  let isDrawingShape = false;
  let shapeStartX = 0;
  let shapeStartY = 0;
  let tempShape = null;
  let activeShapeCanvas = null;

  // Per-page containers and Fabric.js canvases
  const pageContainers = {};
  const fabricCanvases = {};
  const canvasStates = {};
  const undoStacks = {};
  const redoStacks = {};

  // Palm rejection state
  let stylusActive = false;
  let stylusTimeout = null;
  const STYLUS_TIMEOUT_MS = 500;

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
      if (MODE === 'pdf') {
        setupScrollListener();
      }
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

  // ============= BLANK CANVAS RENDERING =============

  async function renderBlankCanvas() {
    pagesWrapper.innerHTML = '';

    // Create a canvas sized for the viewport
    const viewer = document.getElementById('canvas-viewer');
    const width = Math.max(viewer.clientWidth - 32, 800) * renderScale;
    const height = Math.max(viewer.clientHeight - 32, 600) * renderScale;

    const pageContainer = document.createElement('div');
    pageContainer.className = 'page-container';
    pageContainer.id = 'page-container-1';
    pageContainer.dataset.page = 1;
    pageContainer.style.width = width + 'px';
    pageContainer.style.height = height + 'px';
    pageContainer.style.position = 'relative';
    pageContainer.style.background = 'white';

    const annotationCanvas = document.createElement('canvas');
    annotationCanvas.id = 'annotation-canvas-1';
    annotationCanvas.className = 'annotation-canvas';
    annotationCanvas.width = width;
    annotationCanvas.height = height;
    pageContainer.appendChild(annotationCanvas);

    pagesWrapper.appendChild(pageContainer);
    pageContainers[1] = pageContainer;

    // Initialize Fabric.js canvas
    const fabricCanvas = new fabric.Canvas(annotationCanvas, {
      isDrawingMode: true,
      width: width,
      height: height,
      selection: false,
      allowTouchScrolling: false,
      enablePointerEvents: true,
      enableRetinaScaling: !isIOSSafari
    });

    // Restore state if exists
    if (canvasStates[1]) {
      await new Promise(resolve => {
        fabricCanvas.loadFromJSON(canvasStates[1], resolve);
      });
    }

    // Initialize undo/redo stacks
    if (!undoStacks[1]) undoStacks[1] = [];
    if (!redoStacks[1]) redoStacks[1] = [];

    setupCanvasHandlers(fabricCanvas, 1, pageContainer);
    fabricCanvases[1] = fabricCanvas;
    applyToolSettings(fabricCanvas);
    updateUndoRedoButtons();
  }

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
          enableRetinaScaling: !isIOSSafari
        });

        // Restore state if exists
        if (canvasStates[pageNum]) {
          await new Promise(resolve => {
            fabricCanvas.loadFromJSON(canvasStates[pageNum], resolve);
          });
        }

        // Initialize undo/redo stacks
        if (!undoStacks[pageNum]) undoStacks[pageNum] = [];
        if (!redoStacks[pageNum]) redoStacks[pageNum] = [];

        setupCanvasHandlers(fabricCanvas, pageNum, pageContainer);
        fabricCanvases[pageNum] = fabricCanvas;
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
          if (e.pointerType === 'touch' && stylusActive) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
          }
        }, { capture: true });

        upperCanvas.addEventListener('pointermove', e => {
          if (e.pointerType === 'touch' && stylusActive) {
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

    // Track changes for undo
    fabricCanvas.on('object:added', function() {
      saveToUndoStack(pageNum);
      redoStacks[pageNum] = [];
      updateUndoRedoButtons();
    });

    fabricCanvas.on('object:removed', function() {
      saveToUndoStack(pageNum);
      updateUndoRedoButtons();
    });

    fabricCanvas.on('object:modified', function() {
      saveToUndoStack(pageNum);
      redoStacks[pageNum] = [];
      updateUndoRedoButtons();
    });

    // Handle precision eraser
    fabricCanvas.on('path:created', function(e) {
      if (currentTool === 'eraser-precision' && e.path) {
        e.path.set({
          globalCompositeOperation: 'destination-out',
          isEraser: true,
          stroke: '#000000'
        });
        fabricCanvas.renderAll();
      }
    });
  }

  function saveToUndoStack(pageNum) {
    const canvas = fabricCanvases[pageNum];
    if (canvas) {
      const json = canvas.toJSON(['globalCompositeOperation', 'isEraser']);
      undoStacks[pageNum].push(JSON.stringify(json));
      if (undoStacks[pageNum].length > 50) {
        undoStacks[pageNum].shift();
      }
    }
  }

  // ============= SCROLL TRACKING =============

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
      }
    });
  }

  // ============= TOOL MANAGEMENT =============

  window.setTool = function(tool) {
    if (tool === 'eraser') {
      tool = eraserMode;
    }

    currentTool = tool;

    // Update UI - tool buttons
    document.querySelectorAll('.ftool-btn[data-tool]').forEach(btn => {
      const btnTool = btn.dataset.tool;
      const isActive = btnTool === tool ||
        (btnTool === 'eraser' && (tool === 'eraser' || tool === 'eraser-precision')) ||
        (btnTool === 'shape' && tool === 'shape');
      btn.classList.toggle('active', isActive);
    });

    closeAllDropdowns();

    const editorContent = document.getElementById('canvas-viewer');
    if (editorContent) {
      editorContent.classList.toggle('select-mode', tool === 'select');
      editorContent.classList.toggle('pan-mode', tool === 'pan');
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

    switch (currentTool) {
      case 'select':
        canvas.isDrawingMode = false;
        canvas.defaultCursor = 'default';
        canvas.selection = true;
        canvas.forEachObject(obj => { obj.selectable = true; });
        break;

      case 'pen':
        canvas.isDrawingMode = true;
        canvas.freeDrawingBrush = new fabric.SmoothPencilBrush(canvas);
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
        canvas.on('mouse:down', createEraserHandler(canvas));
        canvas.forEachObject(obj => { obj.selectable = false; });
        break;

      case 'eraser-precision':
        canvas.isDrawingMode = true;
        canvas.freeDrawingBrush = new fabric.PencilBrush(canvas);
        canvas.freeDrawingBrush.color = 'rgba(255,255,255,0.01)';
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
    }
  }

  // Factory functions for handlers
  function createEraserHandler(canvas) {
    return function(e) {
      if (e.target && canvas) {
        canvas.remove(e.target);
        canvas.renderAll();
      }
    };
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
      if (canvas && canvas.freeDrawingBrush && currentTool === 'pen') {
        canvas.freeDrawingBrush.color = strokeColor;
      }
    });
  };

  window.setPenWidth = function(width) {
    strokeWidth = width;
    document.querySelectorAll('#pen-dropdown .width-option').forEach(o => {
      o.classList.toggle('active', parseInt(o.dataset.width) === width);
    });

    Object.values(fabricCanvases).forEach(canvas => {
      if (canvas && canvas.freeDrawingBrush && currentTool === 'pen') {
        canvas.freeDrawingBrush.width = strokeWidth;
      }
    });
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
  };

  window.setEraserMode = function(mode) {
    eraserMode = mode;
    document.querySelectorAll('#eraser-dropdown .eraser-mode').forEach(m => {
      m.classList.toggle('active', m.dataset.mode === mode);
    });
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
          closeAllDropdowns();
          if (!isOpen) {
            dropdown.classList.add('open');
            positionDropdown(btn, dropdown);
          }
        });
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.tool-wrapper')) {
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
  }

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

    handle.addEventListener('mousedown', startDrag);
    handle.addEventListener('touchstart', startDrag, { passive: false });

    function clearDockedClasses() {
      toolbar.classList.remove('docked-left', 'docked-right', 'docked-top', 'docked-bottom');
    }

    function startDrag(e) {
      isDragging = true;
      toolbar.style.transition = 'none';

      if (e.type === 'touchstart') {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      } else {
        startX = e.clientX;
        startY = e.clientY;
      }

      const rect = toolbar.getBoundingClientRect();
      initialX = rect.left;
      initialY = rect.top;

      clearDockedClasses();
      toolbar.style.transform = 'none';
      toolbar.style.left = initialX + 'px';
      toolbar.style.top = initialY + 'px';
      toolbar.style.right = 'auto';
      toolbar.style.bottom = 'auto';

      document.addEventListener('mousemove', drag);
      document.addEventListener('mouseup', stopDrag);
      document.addEventListener('touchmove', drag, { passive: false });
      document.addEventListener('touchend', stopDrag);

      e.preventDefault();
    }

    function drag(e) {
      if (!isDragging) return;

      let clientX, clientY;
      if (e.type === 'touchmove') {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
        e.preventDefault();
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }

      const dx = clientX - startX;
      const dy = clientY - startY;

      let newX = initialX + dx;
      let newY = initialY + dy;

      const maxX = window.innerWidth - 50;
      const maxY = window.innerHeight - 50;
      newX = Math.max(-20, Math.min(newX, maxX));
      newY = Math.max(-20, Math.min(newY, maxY));

      toolbar.style.left = newX + 'px';
      toolbar.style.top = newY + 'px';
      toolbar.style.right = 'auto';
      toolbar.style.bottom = 'auto';
    }

    function stopDrag() {
      isDragging = false;
      document.removeEventListener('mousemove', drag);
      document.removeEventListener('mouseup', stopDrag);
      document.removeEventListener('touchmove', drag);
      document.removeEventListener('touchend', stopDrag);

      const rect = toolbar.getBoundingClientRect();
      const viewWidth = window.innerWidth;
      const viewHeight = window.innerHeight;

      const handleY = rect.top + rect.height / 2;
      const handleX = rect.left + rect.width / 2;

      const topZoneHeight = rect.height;
      const bottomZoneHeight = rect.height * 3;

      toolbar.style.transition = 'all 0.2s ease-out';

      closeAllDropdowns();

      if (handleY < topZoneHeight) {
        clearDockedClasses();
        toolbar.classList.add('docked-top');
        toolbar.style.top = '0';
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
    const stylusIndicator = document.getElementById('stylus-indicator');

    function setStylusActive(active) {
      stylusActive = active;
      if (stylusIndicator) {
        stylusIndicator.classList.toggle('hidden', !active);
      }
    }

    // Track stylus on all page containers
    pagesWrapper.addEventListener('pointermove', e => {
      if (e.pointerType === 'pen') {
        if (stylusTimeout) {
          clearTimeout(stylusTimeout);
          stylusTimeout = null;
        }
      }
    }, { passive: true });

    pagesWrapper.addEventListener('pointerdown', e => {
      if (!e.target.classList.contains('upper-canvas')) return;

      if (e.pointerType === 'pen') {
        setStylusActive(true);
        if (stylusTimeout) {
          clearTimeout(stylusTimeout);
          stylusTimeout = null;
        }
        e.target.setPointerCapture(e.pointerId);
      } else if (e.pointerType === 'touch') {
        if (stylusActive) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }, { passive: false });

    pagesWrapper.addEventListener('pointerup', e => {
      if (e.pointerType === 'pen') {
        stylusTimeout = setTimeout(() => {
          setStylusActive(false);
        }, STYLUS_TIMEOUT_MS);
      }
    });

    pagesWrapper.addEventListener('pointercancel', e => {
      if (e.pointerType === 'pen') {
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
      for (const touch of e.changedTouches) {
        activeTouches.set(touch.identifier, touch);
      }

      if (stylusActive && activeTouches.size === 1) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (activeTouches.size === 2) {
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

      if (stylusActive && activeTouches.size === 1) {
        e.preventDefault();
        e.stopPropagation();
        return;
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
        const maxZoom = isIOSSafari ? 2.0 : 3.0;
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

      if (activeTouches.size < 2 && isPinching) {
        isPinching = false;

        setTimeout(() => {
          if (!isPinching) {
            Object.values(fabricCanvases).forEach(canvas => {
              applyToolSettings(canvas);
            });
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
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    });

    // Autosave
    setInterval(saveState, 30000);
    window.addEventListener('beforeunload', saveState);
  }

  // ============= ZOOM CONTROLS =============

  window.zoomIn = function() {
    if (zoomLevel < 3.0) {
      zoomLevel = Math.min(zoomLevel + 0.25, 3.0);
      applyZoomToAllPages();
      updateZoomDisplay();
    }
  };

  window.zoomOut = function() {
    if (zoomLevel > 0.5) {
      zoomLevel = Math.max(zoomLevel - 0.25, 0.5);
      applyZoomToAllPages();
      updateZoomDisplay();
    }
  };

  window.zoomFit = function() {
    zoomLevel = 1.0;
    applyZoomToAllPages();
    updateZoomDisplay();
  };

  function applyZoomToAllPages() {
    const actualScale = fitScale * zoomLevel;
    const viewer = document.getElementById('canvas-viewer');

    Object.values(pageContainers).forEach(container => {
      container.style.transform = 'scale(' + actualScale + ')';
      container.style.transformOrigin = 'top left';
    });

    if (pageContainers[1]) {
      const firstCanvas = fabricCanvases[1];
      if (firstCanvas) {
        const scaledHeight = firstCanvas.height * actualScale;
        const originalHeight = firstCanvas.height;
        const scaledWidth = firstCanvas.width * actualScale;
        const originalWidth = firstCanvas.width;

        const viewerWidth = viewer.clientWidth;
        const leftPadding = Math.max(16, (viewerWidth - scaledWidth) / 2);
        pagesWrapper.style.paddingLeft = leftPadding + 'px';
        pagesWrapper.style.paddingRight = '16px';

        Object.values(pageContainers).forEach(container => {
          container.style.marginBottom = ((scaledHeight - originalHeight) + 20) + 'px';
          container.style.marginRight = Math.max(0, (scaledWidth - originalWidth)) + 'px';
        });
      }
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
      if (MODE === 'ink') {
        pageInfo.textContent = '';
      } else {
        pageInfo.textContent = 'Page ' + currentPage + ' of ' + totalPages;
      }
    }
  }

  // ============= UNDO / REDO =============

  window.undo = function() {
    const stack = undoStacks[currentPage];
    const canvas = fabricCanvases[currentPage];

    if (stack && stack.length > 1 && canvas) {
      const currentState = stack.pop();
      redoStacks[currentPage].push(currentState);

      const prevState = stack[stack.length - 1];
      canvas.loadFromJSON(prevState, () => {
        updateUndoRedoButtons();
      });
    } else if (stack && stack.length === 1 && canvas) {
      const currentState = stack.pop();
      redoStacks[currentPage].push(currentState);
      canvas.clear();
      updateUndoRedoButtons();
    }
  };

  window.redo = function() {
    const stack = redoStacks[currentPage];
    const canvas = fabricCanvases[currentPage];

    if (stack && stack.length > 0 && canvas) {
      const nextState = stack.pop();
      undoStacks[currentPage].push(nextState);

      canvas.loadFromJSON(nextState, () => {
        updateUndoRedoButtons();
      });
    }
  };

  function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');

    if (undoBtn) {
      undoBtn.disabled = !undoStacks[currentPage] || undoStacks[currentPage].length === 0;
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
    return 'annotator-state-' + NOTE_ID + '-' + BLOCK_ID;
  }

  function saveState() {
    try {
      Object.keys(fabricCanvases).forEach(pageNum => {
        canvasStates[pageNum] = fabricCanvases[pageNum].toJSON(['globalCompositeOperation', 'isEraser']);
      });

      const hasAnnotations = Object.values(canvasStates).some(state =>
        state && state.objects && state.objects.length > 0
      );

      if (hasAnnotations) {
        localStorage.setItem(getStateKey(), JSON.stringify({
          canvasStates: canvasStates,
          currentPage: currentPage,
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
        return;
      }

      // Fall back to localStorage
      const saved = localStorage.getItem(getStateKey());
      if (saved) {
        const data = JSON.parse(saved);
        if (data.canvasStates) {
          Object.assign(canvasStates, data.canvasStates);
          if (data.currentPage) currentPage = data.currentPage;
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
        canvasStates[pageNum] = fabricCanvases[pageNum].toJSON(['globalCompositeOperation', 'isEraser']);
      });

      const response = await fetch('/note/' + NOTE_ID + '/canvas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canvasStates: canvasStates,
          currentPage: currentPage
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
    if (confirm('Are you sure you want to exit without saving? Any unsaved changes will be lost.')) {
      window.location.href = '/';
    }
  };

  window.toggleSaveDropdown = function(e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('save-dropdown');
    if (dropdown) {
      dropdown.classList.toggle('open');
    }
  };

  function closeSaveDropdown() {
    const dropdown = document.getElementById('save-dropdown');
    if (dropdown) {
      dropdown.classList.remove('open');
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

  async function loadTranscript() {
    try {
      const response = await fetch('/note/' + NOTE_ID + '/transcript');
      const result = await response.json();

      if (result.transcript) {
        fullTranscript = result.transcript;
        updateTranscriptDisplay();
      }

      if (result.summary) {
        const summaryContainer = document.getElementById('audio-summary-container');
        const summaryEl = document.getElementById('audio-summary');
        if (summaryContainer && summaryEl) {
          summaryEl.textContent = result.summary;
          summaryContainer.classList.remove('hidden');
        }
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
        transcriptEl.innerHTML = '<p>' + fullTranscript + '</p>';
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

      // Use webm/opus for better compatibility
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      mediaRecorder = new MediaRecorder(stream, { mimeType });
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      mediaRecorder.start(1000); // Collect data every second
      isRecording = true;
      recordingStartTime = Date.now();

      // Update UI
      const recordBtn = document.getElementById('audio-record-btn');
      const recordIcon = document.getElementById('audio-record-icon');
      const statusText = document.getElementById('audio-status-text');
      const durationEl = document.getElementById('audio-duration');

      recordBtn?.classList.add('recording');
      if (recordIcon) {
        recordIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2"/>';
      }
      if (statusText) statusText.textContent = 'Recording...';
      durationEl?.classList.remove('hidden');

      // Update duration display
      recordingInterval = setInterval(updateDuration, 1000);

      // Send chunks for transcription every 15 seconds
      transcriptionInterval = setInterval(sendForTranscription, 15000);

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

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }

    clearInterval(recordingInterval);
    clearInterval(transcriptionInterval);

    isRecording = false;

    // Send final chunk for transcription
    if (audioChunks.length > 0) {
      sendForTranscription();
    }

    // Update UI
    const recordBtn = document.getElementById('audio-record-btn');
    const recordIcon = document.getElementById('audio-record-icon');
    const statusText = document.getElementById('audio-status-text');

    recordBtn?.classList.remove('recording');
    if (recordIcon) {
      recordIcon.innerHTML = '<circle cx="12" cy="12" r="10"/>';
    }
    if (statusText) statusText.textContent = 'Tap to record';
  }

  function updateDuration() {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const secs = (elapsed % 60).toString().padStart(2, '0');

    const durationEl = document.getElementById('audio-duration');
    if (durationEl) {
      durationEl.textContent = mins + ':' + secs;
    }
  }

  async function sendForTranscription() {
    if (audioChunks.length === 0) return;

    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    audioChunks = []; // Clear for next batch

    const formData = new FormData();
    formData.append('audio', blob, 'recording.webm');

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
        fullTranscript += (fullTranscript ? ' ' : '') + result.text;
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
      summarizeBtn.textContent = 'Summarizing...';
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
        const summaryContainer = document.getElementById('audio-summary-container');
        const summaryEl = document.getElementById('audio-summary');
        if (summaryContainer && summaryEl) {
          summaryEl.textContent = result.summary;
          summaryContainer.classList.remove('hidden');
        }
      } else if (result.error) {
        alert('Summarization failed: ' + result.error);
      }
    } catch (err) {
      console.error('Summarization failed:', err);
      alert('Summarization failed: ' + err.message);
    } finally {
      if (summarizeBtn) {
        summarizeBtn.disabled = false;
        summarizeBtn.textContent = 'Summarize';
      }
    }
  };

  // ============= START =============
  init();

})();
