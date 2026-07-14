/**
 * Ink Canvas - Digital Inking for Notes
 * Based on Schoolhouse PDF Annotator
 */
(function() {
  'use strict';

  // Detect iOS Safari
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isIOSSafari = isIOS || (isSafari && navigator.maxTouchPoints > 0);

  // State
  let currentTool = 'pen';
  let strokeColor = '#000000';
  let strokeWidth = 4;
  let highlighterColor = 'rgba(255,255,0,0.4)';
  let highlighterWidth = 20;

  // Per-block canvases
  const fabricCanvases = {};
  const undoStacks = {};
  const redoStacks = {};

  // Auto-save
  let saveTimeout = null;
  const AUTO_SAVE_DELAY = 2000;

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

  // ============= INITIALIZATION =============

  window.initInkCanvas = function(blockId, canvasId, existingState) {
    const canvasEl = document.getElementById(canvasId);
    if (!canvasEl) {
      console.error('Canvas element not found:', canvasId);
      return;
    }

    const container = canvasEl.parentElement;
    const width = container.clientWidth || 800;
    const height = 600; // Default height

    canvasEl.width = width;
    canvasEl.height = height;

    const fabricCanvas = new fabric.Canvas(canvasEl, {
      isDrawingMode: true,
      width: width,
      height: height,
      backgroundColor: '#ffffff',
      selection: false,
      enableRetinaScaling: !isIOSSafari
    });

    // Restore existing state
    if (existingState && Object.keys(existingState).length > 0) {
      fabricCanvas.loadFromJSON(existingState, function() {
        fabricCanvas.renderAll();
      });
    }

    // Initialize undo/redo stacks
    undoStacks[blockId] = [];
    redoStacks[blockId] = [];

    // Set up canvas handlers
    setupCanvasHandlers(fabricCanvas, blockId);
    fabricCanvases[blockId] = fabricCanvas;
    applyToolSettings(fabricCanvas);

    // Save initial state to undo stack
    saveToUndoStack(blockId);

    return fabricCanvas;
  };

  function setupCanvasHandlers(fabricCanvas, blockId) {
    fabricCanvas.freeDrawingBrush = new fabric.SmoothPencilBrush(fabricCanvas);
    fabricCanvas.freeDrawingBrush.color = strokeColor;
    fabricCanvas.freeDrawingBrush.width = strokeWidth;

    fabricCanvas.on('object:added', function() {
      saveToUndoStack(blockId);
      redoStacks[blockId] = [];
      triggerAutoSave(blockId);
    });

    fabricCanvas.on('object:modified', function() {
      saveToUndoStack(blockId);
      redoStacks[blockId] = [];
      triggerAutoSave(blockId);
    });

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

  function saveToUndoStack(blockId) {
    const canvas = fabricCanvases[blockId];
    if (canvas) {
      const json = canvas.toJSON(['globalCompositeOperation', 'isEraser']);
      undoStacks[blockId].push(JSON.stringify(json));
      if (undoStacks[blockId].length > 50) {
        undoStacks[blockId].shift();
      }
    }
  }

  function triggerAutoSave(blockId) {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(function() {
      saveInkCanvas(blockId);
    }, AUTO_SAVE_DELAY);
  }

  // ============= TOOL MANAGEMENT =============

  window.setInkTool = function(tool) {
    currentTool = tool;

    document.querySelectorAll('.ink-tool-btn').forEach(btn => {
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
          if (e.target) {
            canvas.remove(e.target);
            canvas.renderAll();
          }
        });
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
    }
  }

  window.setInkColor = function(color) {
    strokeColor = color;
    document.querySelectorAll('.ink-color-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.color === color);
    });
    Object.values(fabricCanvases).forEach(canvas => {
      if (canvas.freeDrawingBrush && currentTool === 'pen') {
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

  window.setStrokeWidth = function(width) {
    strokeWidth = width;
    Object.values(fabricCanvases).forEach(canvas => {
      if (canvas.freeDrawingBrush && currentTool === 'pen') {
        canvas.freeDrawingBrush.width = width;
      }
    });
  };

  // ============= UNDO/REDO =============

  window.inkUndo = function(blockId) {
    const stack = undoStacks[blockId];
    const canvas = fabricCanvases[blockId];

    if (stack && stack.length > 1 && canvas) {
      const currentState = stack.pop();
      redoStacks[blockId].push(currentState);

      const prevState = stack[stack.length - 1];
      canvas.loadFromJSON(prevState, () => {
        canvas.renderAll();
      });
    }
  };

  window.inkRedo = function(blockId) {
    const stack = redoStacks[blockId];
    const canvas = fabricCanvases[blockId];

    if (stack && stack.length > 0 && canvas) {
      const nextState = stack.pop();
      undoStacks[blockId].push(nextState);

      canvas.loadFromJSON(nextState, () => {
        canvas.renderAll();
      });
    }
  };

  window.inkClear = function(blockId) {
    const canvas = fabricCanvases[blockId];
    if (canvas && confirm('Clear all ink?')) {
      canvas.clear();
      canvas.backgroundColor = '#ffffff';
      canvas.renderAll();
      saveToUndoStack(blockId);
      triggerAutoSave(blockId);
    }
  };

  // ============= SAVE/RESTORE =============

  window.saveInkCanvas = function(blockId) {
    const canvas = fabricCanvases[blockId];
    if (!canvas) return;

    const state = canvas.toJSON(['globalCompositeOperation', 'isEraser']);

    fetch('/block/' + blockId + '/ink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvas_state: state })
    }).then(function(r) {
      return r.json();
    }).then(function(result) {
      if (result.success) {
        showSaveIndicator(blockId);
      }
    }).catch(function(err) {
      console.error('Failed to save ink:', err);
    });
  };

  function showSaveIndicator(blockId) {
    const indicator = document.getElementById('save-indicator-' + blockId);
    if (indicator) {
      indicator.classList.remove('hidden');
      setTimeout(() => {
        indicator.classList.add('hidden');
      }, 1500);
    }
  }

  window.getInkCanvasState = function(blockId) {
    const canvas = fabricCanvases[blockId];
    if (!canvas) return null;
    return canvas.toJSON(['globalCompositeOperation', 'isEraser']);
  };

  // ============= RESIZE =============

  window.resizeInkCanvas = function(blockId, height) {
    const canvas = fabricCanvases[blockId];
    if (canvas) {
      canvas.setHeight(height);
      canvas.renderAll();
    }
  };

})();
