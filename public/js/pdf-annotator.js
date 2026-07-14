/**
 * PDF Annotator - PDF.js + Fabric.js Integration
 * Simplified version for Notes app
 */
(function() {
  'use strict';

  // Configure PDF.js worker
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  // Detect device types
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isIOSSafari = isIOS || (isSafari && navigator.maxTouchPoints > 0);
  const isAndroid = /Android/.test(navigator.userAgent);
  const isSamsungBrowser = /SamsungBrowser/.test(navigator.userAgent);
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // State
  let pdfDoc = null;
  let currentPage = 1;
  let totalPages = 0;
  let renderScale = isIOSSafari ? 1.5 : 2.0;
  let zoomLevel = 1.0;
  let fitScale = 1.0;
  let currentTool = 'pen';
  let strokeColor = '#000000';
  let strokeWidth = 4;
  let highlighterColor = 'rgba(255,255,0,0.4)';
  let highlighterWidth = 20;

  // Per-page containers and Fabric.js canvases
  const pageContainers = {};
  const fabricCanvases = {};
  const canvasStates = {};
  const undoStacks = {};
  const redoStacks = {};

  // Auto-save interval
  let autoSaveInterval = null;
  const AUTO_SAVE_MS = 30000;

  // DOM elements
  const pagesWrapper = document.getElementById('pages-wrapper');
  const pageInfo = document.getElementById('page-info');
  const loadingOverlay = document.getElementById('loading-overlay');

  // ============= INITIALIZATION =============

  async function init() {
    console.log('PDF Annotator: Starting init...');

    if (typeof pdfjsLib === 'undefined') {
      showError('Failed to load PDF viewer library');
      return;
    }

    if (typeof fabric === 'undefined') {
      showError('Failed to load annotation library');
      return;
    }

    try {
      console.log('Loading PDF from:', PDF_URL);
      const loadingTask = pdfjsLib.getDocument(PDF_URL);
      pdfDoc = await loadingTask.promise;
      totalPages = pdfDoc.numPages;

      const firstPage = await pdfDoc.getPage(1);
      const unscaledViewport = firstPage.getViewport({ scale: 1 });
      const renderedWidth = unscaledViewport.width * renderScale;
      const viewerWidth = document.getElementById('pdf-viewer').clientWidth - 32;
      fitScale = viewerWidth / renderedWidth;

      await restoreAnnotations();
      await renderAllPages();
      updatePageInfo();
      setupEventListeners();
      setupScrollListener();
      startAutoSave();
      loadingOverlay.style.display = 'none';

    } catch (error) {
      console.error('Error loading PDF:', error);
      showError('Failed to load PDF: ' + (error.message || 'Unknown error'));
    }
  }

  function showError(message) {
    loadingOverlay.innerHTML = '<div class="text-center"><p class="text-red-600 mb-4">' + message + '</p><a href="javascript:history.back()" class="text-blue-600 hover:underline">Go Back</a></div>';
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

        // Create page container
        const pageContainer = document.createElement('div');
        pageContainer.className = 'page-container';
        pageContainer.id = 'page-container-' + pageNum;
        pageContainer.dataset.page = pageNum;
        pageContainer.style.width = viewport.width + 'px';
        pageContainer.style.height = viewport.height + 'px';
        pageContainer.style.position = 'relative';
        pageContainer.style.marginBottom = '20px';
        pageContainer.style.transformOrigin = 'top left';
        pageContainer.style.transform = 'scale(' + (fitScale * zoomLevel) + ')';

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
        annotationCanvas.style.position = 'absolute';
        annotationCanvas.style.top = '0';
        annotationCanvas.style.left = '0';
        pageContainer.appendChild(annotationCanvas);

        pagesWrapper.appendChild(pageContainer);
        pageContainers[pageNum] = pageContainer;

        // Initialize Fabric.js canvas with touch optimizations
        const fabricCanvas = new fabric.Canvas(annotationCanvas, {
          isDrawingMode: true,
          width: viewport.width,
          height: viewport.height,
          selection: false,
          allowTouchScrolling: false,
          enableRetinaScaling: !isIOSSafari && !isAndroid,
          // Touch/stylus settings
          stopContextMenu: true,
          fireRightClick: false,
          targetFindTolerance: isTouchDevice ? 15 : 5
        });

        // Palm rejection: only draw with stylus or single touch
        if (isTouchDevice) {
          annotationCanvas.addEventListener('touchstart', function(e) {
            // If stylus (pressure > 0) or single touch, allow drawing
            // Multi-touch likely means palm or pinch gesture
            if (e.touches.length > 1) {
              fabricCanvas.isDrawingMode = false;
            } else {
              fabricCanvas.isDrawingMode = (currentTool === 'pen' || currentTool === 'highlighter');
            }
          }, { passive: true });

          annotationCanvas.addEventListener('touchend', function() {
            // Restore drawing mode after touch ends
            if (currentTool === 'pen' || currentTool === 'highlighter') {
              fabricCanvas.isDrawingMode = true;
            }
          }, { passive: true });
        }

        // Restore state if exists
        if (canvasStates[pageNum]) {
          await new Promise(resolve => {
            fabricCanvas.loadFromJSON(canvasStates[pageNum], resolve);
          });
        }

        // Initialize undo/redo stacks
        if (!undoStacks[pageNum]) undoStacks[pageNum] = [];
        if (!redoStacks[pageNum]) redoStacks[pageNum] = [];

        setupCanvasHandlers(fabricCanvas, pageNum);
        fabricCanvases[pageNum] = fabricCanvas;
        applyToolSettings(fabricCanvas);

      } catch (pageError) {
        console.error('Error rendering page ' + pageNum + ':', pageError);
      }
    }

    updateUndoRedoButtons();
  }

  function setupCanvasHandlers(fabricCanvas, pageNum) {
    fabricCanvas.freeDrawingBrush = new fabric.SmoothPencilBrush(fabricCanvas);
    fabricCanvas.freeDrawingBrush.color = strokeColor;
    fabricCanvas.freeDrawingBrush.width = strokeWidth;

    fabricCanvas.on('object:added', function() {
      saveToUndoStack(pageNum);
      redoStacks[pageNum] = [];
      updateUndoRedoButtons();
    });

    fabricCanvas.on('object:modified', function() {
      saveToUndoStack(pageNum);
      redoStacks[pageNum] = [];
      updateUndoRedoButtons();
    });
  }

  function saveToUndoStack(pageNum) {
    const canvas = fabricCanvases[pageNum];
    if (canvas) {
      const json = canvas.toJSON(['globalCompositeOperation']);
      undoStacks[pageNum].push(JSON.stringify(json));
      if (undoStacks[pageNum].length > 50) {
        undoStacks[pageNum].shift();
      }
    }
  }

  // ============= SCROLL TRACKING =============

  function setupScrollListener() {
    const pdfViewer = document.getElementById('pdf-viewer');

    pdfViewer.addEventListener('scroll', () => {
      const viewerRect = pdfViewer.getBoundingClientRect();
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
    currentTool = tool;

    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });

    Object.values(fabricCanvases).forEach(canvas => {
      applyToolSettings(canvas);
    });
  };

  function applyToolSettings(canvas) {
    canvas.off('mouse:down');

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
        canvas.on('mouse:down', function(e) {
          if (e.target && !e.target.isTeacherMark) {
            canvas.remove(e.target);
            canvas.renderAll();
          }
        });
        canvas.forEachObject(obj => { obj.selectable = false; });
        break;

      case 'text':
        canvas.isDrawingMode = false;
        canvas.defaultCursor = 'text';
        canvas.on('mouse:down', function(e) {
          if (!e.target) {
            const pointer = canvas.getPointer(e.e);
            const text = new fabric.IText('', {
              left: pointer.x,
              top: pointer.y,
              fontSize: 24,
              fill: strokeColor,
              fontFamily: 'sans-serif'
            });
            canvas.add(text);
            canvas.setActiveObject(text);
            text.enterEditing();
          }
        });
        canvas.forEachObject(obj => { obj.selectable = false; });
        break;
    }
  }

  window.setColor = function(color) {
    strokeColor = color;
    document.querySelectorAll('.color-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.color === color);
    });
    Object.values(fabricCanvases).forEach(canvas => {
      if (canvas.freeDrawingBrush) {
        canvas.freeDrawingBrush.color = color;
      }
    });
  };

  window.setHighlighterColor = function(color) {
    highlighterColor = color;
    if (currentTool === 'highlighter') {
      Object.values(fabricCanvases).forEach(canvas => {
        if (canvas.freeDrawingBrush) {
          canvas.freeDrawingBrush.color = color;
        }
      });
    }
  };

  // ============= ZOOM =============

  window.zoomIn = function() {
    if (zoomLevel < 3.0) {
      zoomLevel = Math.min(zoomLevel + 0.25, 3.0);
      applyZoom();
    }
  };

  window.zoomOut = function() {
    if (zoomLevel > 0.5) {
      zoomLevel = Math.max(zoomLevel - 0.25, 0.5);
      applyZoom();
    }
  };

  function applyZoom() {
    const actualScale = fitScale * zoomLevel;
    Object.values(pageContainers).forEach(container => {
      container.style.transform = 'scale(' + actualScale + ')';
    });
    document.getElementById('zoom-display').textContent = Math.round(zoomLevel * 100) + '%';
  }

  // ============= UNDO/REDO =============

  window.undo = function() {
    const stack = undoStacks[currentPage];
    const canvas = fabricCanvases[currentPage];

    if (stack && stack.length > 1 && canvas) {
      const currentState = stack.pop();
      redoStacks[currentPage].push(currentState);

      const prevState = stack[stack.length - 1];
      canvas.loadFromJSON(prevState, () => {
        canvas.renderAll();
        updateUndoRedoButtons();
      });
    }
  };

  window.redo = function() {
    const stack = redoStacks[currentPage];
    const canvas = fabricCanvases[currentPage];

    if (stack && stack.length > 0 && canvas) {
      const nextState = stack.pop();
      undoStacks[currentPage].push(nextState);

      canvas.loadFromJSON(nextState, () => {
        canvas.renderAll();
        updateUndoRedoButtons();
      });
    }
  };

  function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');

    if (undoBtn) {
      undoBtn.disabled = !undoStacks[currentPage] || undoStacks[currentPage].length <= 1;
    }
    if (redoBtn) {
      redoBtn.disabled = !redoStacks[currentPage] || redoStacks[currentPage].length === 0;
    }
  }

  // ============= SAVE/RESTORE =============

  async function restoreAnnotations() {
    try {
      const response = await fetch('/block/' + BLOCK_ID + '/annotations');
      const data = await response.json();

      if (data.canvas_states) {
        Object.keys(data.canvas_states).forEach(pageNum => {
          canvasStates[parseInt(pageNum)] = data.canvas_states[pageNum];
        });
      }
      currentPage = data.current_page || 1;
    } catch (err) {
      console.error('Failed to restore annotations:', err);
    }
  }

  window.saveAnnotations = async function() {
    const states = {};

    Object.keys(fabricCanvases).forEach(pageNum => {
      const canvas = fabricCanvases[pageNum];
      if (canvas) {
        states[pageNum] = canvas.toJSON(['globalCompositeOperation']);
      }
    });

    try {
      const response = await fetch('/block/' + BLOCK_ID + '/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          canvas_states: states,
          current_page: currentPage
        })
      });

      const result = await response.json();
      if (result.success) {
        showSaveIndicator();
      }
    } catch (err) {
      console.error('Failed to save annotations:', err);
    }
  };

  function showSaveIndicator() {
    const indicator = document.getElementById('save-indicator');
    if (indicator) {
      indicator.textContent = 'Saved';
      indicator.classList.remove('hidden');
      setTimeout(() => {
        indicator.classList.add('hidden');
      }, 2000);
    }
  }

  function startAutoSave() {
    autoSaveInterval = setInterval(() => {
      window.saveAnnotations();
    }, AUTO_SAVE_MS);
  }

  // ============= UI UPDATES =============

  function updatePageInfo() {
    if (pageInfo) {
      pageInfo.textContent = currentPage + ' / ' + totalPages;
    }
  }

  function setupEventListeners() {
    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          window.redo();
        } else {
          window.undo();
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        window.saveAnnotations();
      }
    });
  }

  // Save before leaving
  window.addEventListener('beforeunload', () => {
    if (autoSaveInterval) {
      clearInterval(autoSaveInterval);
    }
    // Synchronous save attempt
    const states = {};
    Object.keys(fabricCanvases).forEach(pageNum => {
      const canvas = fabricCanvases[pageNum];
      if (canvas) {
        states[pageNum] = canvas.toJSON(['globalCompositeOperation']);
      }
    });

    navigator.sendBeacon('/block/' + BLOCK_ID + '/annotations', JSON.stringify({
      canvas_states: states,
      current_page: currentPage
    }));
  });

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
