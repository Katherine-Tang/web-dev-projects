import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Camera, Play, RotateCcw, Hand, Trophy, AlertCircle, Sparkles, Clock, Heart, Zap, Snowflake } from 'lucide-react';

/**
 * 手势切水果 (Hand Slice Hero) - 终极完整版
 * * 核心功能:
 * 1. 核心玩法: 基于 MediaPipe 的手势识别，食指作为刀刃。
 * 2. 游戏模式:
 * - 限时模式 (Time Attack): 60秒挑战最高分。
 * - 无尽模式 (Survival): 3条生命值。漏掉水果或切到炸弹扣除1点生命。
 * 3. 特殊机制:
 * - ❄️ 寒冰水果: 切中后时间减慢 (Slow Motion) 5秒。
 * - ✨ 巨型水果: 切中后触发狂热模式 (Frenzy) 5秒，大量水果喷发且无炸弹。
 * 4. 视觉效果: 动态光剑拖尾、粒子爆炸、跟随手势旋转的武士刀。
 */

// --- 游戏常量配置 ---
const GRAVITY = 0.4;             // 重力加速度
const BASE_SPAWN_RATE = 55;      // 基础生成速率 (帧数)
const TRAIL_LENGTH = 8;          // 刀光拖尾长度
const ROUND_TIME = 60;           // 限时模式时长
const SPEED_THRESHOLD = 3;       // 切割所需的最小移动速度
const MAX_LIVES = 3;             // 无尽模式生命值

// 特殊状态持续帧数 (60fps)
const SLOW_MO_DURATION = 300;    // 5秒
const FRENZY_DURATION = 300;     // 5秒

// 水果类型定义
const FRUIT_TYPES = [
  { emoji: '🍉', color: '#ff5252', score: 10, radius: 40, weight: 10 },
  { emoji: '🍊', color: '#ff9800', score: 10, radius: 35, weight: 10 },
  { emoji: '🍋', color: '#ffeb3b', score: 10, radius: 35, weight: 10 },
  { emoji: '🍎', color: '#f44336', score: 10, radius: 35, weight: 10 },
  { emoji: '🥝', color: '#8bc34a', score: 20, radius: 30, weight: 8 },
  { emoji: '🥥', color: '#795548', score: 30, radius: 35, weight: 8 },
  { emoji: '💣', color: '#000000', score: -50, radius: 35, isBomb: true, weight: 6 }, // 炸弹
  { emoji: '❄️', color: '#00ffff', score: 0, radius: 30, isIce: true, weight: 2 },   // 寒冰
  { emoji: '✨', color: '#ffd700', score: 50, radius: 60, isGiant: true, weight: 1 }, // 狂热
];

const App = () => {
  // --- React 状态 (UI层) ---
  const [gameState, setGameState] = useState('loading'); // loading, ready, playing, finished, error
  const [gameMode, setGameMode] = useState('time');      // 'time' | 'survival'
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(ROUND_TIME);
  const [lives, setLives] = useState(MAX_LIVES);
  const [errorMessage, setErrorMessage] = useState('');
  const [highScores, setHighScores] = useState([]);
  
  // --- 游戏引擎 Refs (高性能层) ---
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const requestRef = useRef(null);
  const handLandmarkerRef = useRef(null);
  
  // 游戏实体数据 (不触发 React 重渲染)
  const cursorRef = useRef({ x: -100, y: -100, history: [], angle: 0 });
  const entitiesRef = useRef({
    fruits: [],
    particles: [],
    floatingTexts: [],
    score: 0,
    lives: MAX_LIVES,
    gameMode: 'time',
    slowMoTimer: 0,
    frenzyTimer: 0,
    spawnTimer: 0
  });
  
  // --- 1. 初始化系统 ---
  useEffect(() => {
    // 读取本地排行榜
    const savedScores = JSON.parse(localStorage.getItem('sliceHeroHighScores')) || [];
    setHighScores(savedScores);

    const loadMediaPipe = async () => {
      try {
        const { FilesetResolver, HandLandmarker } = await import(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0"
        );
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
        );
        
        handLandmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 1
        });

        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }
          });
          
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.onloadeddata = () => {
              videoRef.current.play();
              setGameState('ready');
            };
          }
        } else {
          throw new Error("无法访问摄像头，请检查权限设置。");
        }
      } catch (err) {
        console.error(err);
        setGameState('error');
        setErrorMessage("初始化失败: " + (err.message || "无法加载视觉模型"));
      }
    };

    loadMediaPipe();

    return () => {
      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.srcObject.getTracks().forEach(t => t.stop());
      }
      cancelAnimationFrame(requestRef.current);
    };
  }, []);

  // --- 2. 游戏流程控制 ---
  const startGame = (mode) => {
    setGameMode(mode);
    setScore(0);
    setLives(MAX_LIVES);
    setTimeLeft(ROUND_TIME);
    
    // 重置物理引擎状态
    entitiesRef.current = {
      fruits: [],
      particles: [],
      floatingTexts: [],
      score: 0,
      lives: MAX_LIVES,
      gameMode: mode,
      slowMoTimer: 0,
      frenzyTimer: 0,
      spawnTimer: 0
    };
    
    cursorRef.current.history = [];
    setGameState('playing');
  };

  const endGame = () => {
    setGameState('finished');
    updateHighScores(entitiesRef.current.score);
  };

  const updateHighScores = (finalScore) => {
    const newScores = [...highScores, { 
      score: finalScore, 
      date: new Date().toLocaleDateString(), 
      mode: gameMode 
    }]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5); // 只保留前5
      
    setHighScores(newScores);
    localStorage.setItem('sliceHeroHighScores', JSON.stringify(newScores));
  };

  // 倒计时逻辑 (仅限时模式)
  useEffect(() => {
    let timer;
    if (gameState === 'playing' && gameMode === 'time') {
      timer = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            endGame();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [gameState, gameMode]);

  // 同步生命值到 UI
  const syncLives = (newLives) => {
    setLives(newLives);
    if (newLives <= 0) {
      endGame();
    }
  };

  // --- 3. 游戏主循环 (Render Loop) ---
  const animate = useCallback(() => {
    if (gameState !== 'playing' && gameState !== 'ready') {
      if (gameState === 'ready') drawIdleScreen();
      return; 
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const video = videoRef.current;
    
    // 自动适配画布尺寸
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    // A. 处理手势追踪
    if (handLandmarkerRef.current && video.readyState >= 2) {
      const detections = handLandmarkerRef.current.detectForVideo(video, performance.now());
      if (detections.landmarks && detections.landmarks.length > 0) {
        const hand = detections.landmarks[0];
        const indexTip = hand[8]; // 食指指尖
        
        // 坐标转换 (镜像处理)
        const x = (1 - indexTip.x) * canvas.width;
        const y = indexTip.y * canvas.height;
        
        // 计算移动角度 (用于刀身旋转)
        if (cursorRef.current.history.length > 0) {
            const lastPos = cursorRef.current.history[cursorRef.current.history.length - 1];
            const dx = x - lastPos.x;
            const dy = y - lastPos.y;
            if (Math.hypot(dx, dy) > 2) { // 只有移动足够距离才改变角度
                cursorRef.current.angle = Math.atan2(dy, dx);
            }
        }
        
        cursorRef.current.x = x;
        cursorRef.current.y = y;
        cursorRef.current.history.push({ x, y });
        
        if (cursorRef.current.history.length > TRAIL_LENGTH) {
          cursorRef.current.history.shift();
        }
      }
    }

    // B. 绘制基础层
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // 绘制镜像视频
    ctx.scale(-1, 1);
    ctx.translate(-canvas.width, 0);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    // 绘制场景滤镜
    if (entitiesRef.current.slowMoTimer > 0) {
        ctx.fillStyle = 'rgba(0, 150, 255, 0.2)'; // 冰冻滤镜
    } else if (entitiesRef.current.frenzyTimer > 0) {
        ctx.fillStyle = `rgba(255, 200, 0, ${0.1 + Math.random() * 0.1})`; // 狂热闪烁滤镜
    } else {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'; // 普通暗色遮罩
    }
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // C. 游戏逻辑更新与绘制
    if (gameState === 'playing') {
      updatePhysics(canvas);
      detectCollisions();
      drawGameElements(ctx);
    } else {
      drawKnife(ctx); // 准备界面也可以挥刀
    }

    requestRef.current = requestAnimationFrame(animate);
  }, [gameState]);

  // 启动循环
  useEffect(() => {
    requestRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(requestRef.current);
  }, [animate]);

  // --- 4. 物理引擎与碰撞 ---

  const drawIdleScreen = () => {
    // 简单的闲置渲染，用于准备界面
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const video = videoRef.current;
    if (canvas && video && video.readyState >= 2) {
       ctx.save();
       ctx.scale(-1, 1);
       ctx.translate(-canvas.width, 0);
       ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
       ctx.restore();
       ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
       ctx.fillRect(0, 0, canvas.width, canvas.height);
       drawKnife(ctx);
    }
    requestRef.current = requestAnimationFrame(animate);
  }

  const updatePhysics = (canvas) => {
    const entities = entitiesRef.current;
    
    // 1. 计时器更新
    if (entities.slowMoTimer > 0) entities.slowMoTimer--;
    if (entities.frenzyTimer > 0) entities.frenzyTimer--;

    // 2. 时间流逝倍率 (处理 Slow Motion)
    const timeScale = entities.slowMoTimer > 0 ? 0.4 : 1.0; 

    // 3. 水果生成逻辑
    let spawnRate = BASE_SPAWN_RATE;
    if (entities.frenzyTimer > 0) spawnRate = 6; // 狂热模式：极速生成
    else if (entities.slowMoTimer > 0) spawnRate = BASE_SPAWN_RATE * 0.6; 

    entities.spawnTimer++;
    if (entities.spawnTimer > spawnRate) {
      spawnFruit(canvas);
      entities.spawnTimer = 0;
    }

    // 4. 水果物理运动
    entities.fruits.forEach((fruit) => {
      fruit.x += fruit.vx * timeScale;
      fruit.y += fruit.vy * timeScale;
      fruit.vy += GRAVITY * timeScale;
      fruit.rot += fruit.rotSpeed * timeScale;
      
      // 检测掉落
      if (fruit.y > canvas.height + 50) {
        // 无尽模式掉落惩罚 (排除炸弹和特殊水果)
        if (entities.gameMode === 'survival' && !fruit.isBomb && !fruit.isIce && !fruit.isGiant) {
           entities.lives -= 1;
           syncLives(entities.lives);
           createFloatingText(fruit.x, canvas.height - 50, "💔", "red");
        }
        fruit.remove = true;
      }
    });
    // 清理移除的水果
    entities.fruits = entities.fruits.filter(f => !f.remove);

    // 5. 粒子运动
    entities.particles.forEach(p => {
      p.x += p.vx * timeScale;
      p.y += p.vy * timeScale;
      p.vy += (GRAVITY / 2) * timeScale;
      p.life -= 0.03 * timeScale;
    });
    entities.particles = entities.particles.filter(p => p.life > 0);

    // 6. 浮动文字 (不受时间缩放影响，保持UI流畅)
    entities.floatingTexts.forEach(t => {
      t.y -= 1.5;
      t.life -= 0.02;
    });
    entities.floatingTexts = entities.floatingTexts.filter(t => t.life > 0);
  };

  const spawnFruit = (canvas) => {
    // 随机选择水果类型 (基于权重)
    let totalWeight = FRUIT_TYPES.reduce((acc, t) => acc + t.weight, 0);
    let random = Math.random() * totalWeight;
    let type = FRUIT_TYPES[0];
    
    for (let t of FRUIT_TYPES) {
        if (random < t.weight) {
            type = t;
            break;
        }
        random -= t.weight;
    }

    // 狂热模式下强制不生成炸弹
    if (entitiesRef.current.frenzyTimer > 0 && type.isBomb) {
        type = FRUIT_TYPES[0]; // 替换为西瓜
    }

    entitiesRef.current.fruits.push({
      ...type,
      x: Math.random() * (canvas.width - 100) + 50,
      y: canvas.height + 50, // 从底部生成
      vx: (Math.random() - 0.5) * 8, 
      vy: -(Math.random() * 10 + 14), // 向上抛出力度
      rot: 0,
      rotSpeed: (Math.random() - 0.5) * 0.2,
      id: Math.random()
    });
  };

  const detectCollisions = () => {
    const history = cursorRef.current.history;
    if (history.length < 2) return;

    // 取最后两点构成线段
    const p1 = history[history.length - 2];
    const p2 = history[history.length - 1];
    
    // 速度检测：挥动太慢无法切割
    const speed = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (speed < SPEED_THRESHOLD) return; 

    entitiesRef.current.fruits.forEach((fruit, index) => {
      const dist = pointToLineDistance(fruit, p1, p2);
      // 碰撞检测：点到线段距离 < 半径 + 容差
      if (dist < fruit.radius + 15) { 
        handleSlice(fruit, index);
      }
    });
  };

  const pointToLineDistance = (point, v, w) => {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return Math.hypot(point.x - v.x, point.y - v.y);
    let t = ((point.x - v.x) * (w.x - v.x) + (point.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    const projectionX = v.x + t * (w.x - v.x);
    const projectionY = v.y + t * (w.y - v.y);
    return Math.hypot(point.x - projectionX, point.y - projectionY);
  };

  const handleSlice = (fruit, index) => {
    const entities = entitiesRef.current;
    
    // 移除被切中的水果
    entities.fruits.splice(index, 1);
    
    if (fruit.isBomb) {
      if (entities.gameMode === 'survival') {
          // 无尽模式：扣血
          entities.lives -= 1;
          syncLives(entities.lives);
          createFloatingText(fruit.x, fruit.y, "💔", "#ff3333");
      } else {
          // 限时模式：扣分
          entities.score -= 50;
          createFloatingText(fruit.x, fruit.y, "-50", "#ff3333");
      }
      createExplosion(fruit.x, fruit.y, "#000", 25);
    } 
    else if (fruit.isIce) {
        // 触发减速
        entities.slowMoTimer = SLOW_MO_DURATION;
        createFloatingText(fruit.x, fruit.y, "❄️ 冻结!", "#00ffff");
        createExplosion(fruit.x, fruit.y, "#00ffff", 20);
    }
    else if (fruit.isGiant) {
        // 触发狂热
        entities.frenzyTimer = FRENZY_DURATION;
        entities.score += 50;
        setScore(entities.score);
        createFloatingText(fruit.x, fruit.y, "✨ 狂热!", "#ffd700");
        createExplosion(fruit.x, fruit.y, "#ffd700", 30);
    }
    else {
      // 普通得分
      entities.score += fruit.score;
      setScore(entities.score); 
      createFloatingText(fruit.x, fruit.y, `+${fruit.score}`, "#fff");
      createExplosion(fruit.x, fruit.y, fruit.color, 12);
    }
  };

  // --- 5. 渲染绘制函数 ---

  const createExplosion = (x, y, color, count) => {
    for (let i = 0; i < count; i++) {
      entitiesRef.current.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 20,
        vy: (Math.random() - 0.5) * 20,
        life: 1.0,
        color: color,
        size: Math.random() * 6 + 2
      });
    }
  };

  const createFloatingText = (x, y, text, color) => {
    entitiesRef.current.floatingTexts.push({ x, y, text, color, life: 1.0 });
  };

  const drawGameElements = (ctx) => {
    const { fruits, particles, floatingTexts, slowMoTimer, frenzyTimer } = entitiesRef.current;

    // 状态提示文字
    ctx.textAlign = 'center';
    if (slowMoTimer > 0) {
        ctx.font = "bold 24px sans-serif";
        ctx.fillStyle = "#00ffff";
        ctx.shadowColor = "#00ffff";
        ctx.shadowBlur = 10;
        ctx.fillText("❄️ 时间冻结 ❄️", ctx.canvas.width / 2, 100);
        ctx.shadowBlur = 0;
    }
    if (frenzyTimer > 0) {
        ctx.font = "bold 28px sans-serif";
        ctx.fillStyle = "#ffd700";
        ctx.shadowColor = "#ffd700";
        ctx.shadowBlur = 10;
        ctx.fillText("✨ 狂热时刻!!! ✨", ctx.canvas.width / 2, 140);
        ctx.shadowBlur = 0;
    }

    // 绘制水果
    ctx.textBaseline = 'middle';
    fruits.forEach(fruit => {
      ctx.save();
      ctx.translate(fruit.x, fruit.y);
      ctx.rotate(fruit.rot);
      
      const scale = fruit.isGiant ? 1.5 : 1;
      ctx.scale(scale, scale);
      
      // 特殊水果发光效果
      if (fruit.isIce) { ctx.shadowBlur = 20; ctx.shadowColor = '#00ffff'; }
      if (fruit.isGiant) { ctx.shadowBlur = 20; ctx.shadowColor = '#ffd700'; }

      ctx.font = `${fruit.radius * 2}px "Segoe UI Emoji", Arial`;
      ctx.fillText(fruit.emoji, 0, 5);
      ctx.restore();
    });

    // 绘制爆炸粒子
    particles.forEach(p => {
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1.0;

    // 绘制浮动得分
    ctx.font = "bold 32px sans-serif";
    floatingTexts.forEach(t => {
      ctx.globalAlpha = t.life;
      ctx.fillStyle = t.color;
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 3;
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillText(t.text, t.x, t.y);
    });
    ctx.globalAlpha = 1.0;

    drawKnife(ctx);
  };

  const drawKnife = (ctx) => {
    const { x, y, angle } = cursorRef.current;
    if (x < 0 || y < 0) return;

    // 1. 绘制动态光效拖尾
    const history = cursorRef.current.history;
    if (history.length > 2) {
      ctx.beginPath();
      ctx.moveTo(history[0].x, history[0].y);
      for (let i = 1; i < history.length - 1; i++) {
        const xc = (history[i].x + history[i + 1].x) / 2;
        const yc = (history[i].y + history[i + 1].y) / 2;
        ctx.quadraticCurveTo(history[i].x, history[i].y, xc, yc);
      }
      
      const gradient = ctx.createLinearGradient(
        history[0].x, history[0].y, 
        history[history.length-1].x, history[history.length-1].y
      );
      
      const isFrenzy = entitiesRef.current.frenzyTimer > 0;
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
      gradient.addColorStop(1, isFrenzy ? 'rgba(255, 215, 0, 0.9)' : 'rgba(0, 255, 255, 0.9)');
      
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.shadowBlur = 15;
      ctx.shadowColor = isFrenzy ? 'gold' : 'cyan';
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // 2. 绘制武士刀
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle + Math.PI / 4); // 校正角度

    ctx.beginPath();
    ctx.fillStyle = '#e0e0e0'; // 刀刃银色
    ctx.moveTo(0, 0);
    ctx.lineTo(10, -45); // 刀尖
    ctx.lineTo(20, 0);
    ctx.lineTo(5, 5);
    ctx.fill();
    
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#333'; // 刀柄
    ctx.fillRect(5, 5, 10, 25);
    ctx.fillStyle = '#d4af37'; // 刀柄装饰
    ctx.fillRect(5, 10, 10, 3);
    ctx.fillRect(5, 18, 10, 3);

    // 刀尖反光
    if (Math.random() > 0.9) {
        ctx.fillStyle = 'white';
        ctx.beginPath();
        ctx.arc(10, -25, 4, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
  };

  // --- 6. 最终界面渲染 ---
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-white font-sans overflow-hidden relative selection:bg-none select-none">
      
      {/* 游戏内 HUD (分数/血量) */}
      {gameState === 'playing' && (
        <div className="absolute top-4 left-0 right-0 px-4 md:px-8 flex justify-between z-10 pointer-events-none">
          <div className="flex items-center gap-2 bg-black/60 backdrop-blur p-4 rounded-xl border border-white/10 shadow-lg">
            <Trophy className="text-yellow-400 w-6 h-6" />
            <span className="text-3xl font-bold font-mono">{score}</span>
          </div>
          
          {gameMode === 'time' ? (
             <div className={`flex items-center gap-2 bg-black/60 backdrop-blur p-4 rounded-xl border border-white/10 shadow-lg ${timeLeft < 10 ? 'text-red-500 animate-pulse border-red-500/50' : ''}`}>
               <Clock className="w-6 h-6" />
               <span className="text-3xl font-bold font-mono">00:{timeLeft.toString().padStart(2, '0')}</span>
             </div>
          ) : (
             <div className="flex items-center gap-1 bg-black/60 backdrop-blur p-4 rounded-xl border border-white/10 shadow-lg">
               {[...Array(MAX_LIVES)].map((_, i) => (
                 <Heart 
                    key={i} 
                    className={`w-8 h-8 transition-all duration-300 ${i < lives ? 'text-red-500 fill-red-500 scale-100' : 'text-slate-700 scale-75'}`} 
                 />
               ))}
             </div>
          )}
        </div>
      )}

      {/* 主游戏容器 */}
      <div className="relative w-full max-w-4xl aspect-[4/3] bg-black rounded-3xl overflow-hidden shadow-2xl border-4 border-slate-800 ring-1 ring-white/10">
        
        {/* 隐藏的视频源 */}
        <video 
          ref={videoRef} 
          className="absolute opacity-0 pointer-events-none"
          playsInline
          muted
          autoPlay
        />

        {/* 游戏画布 */}
        <canvas 
          ref={canvasRef}
          className="absolute inset-0 w-full h-full object-cover"
        />

        {/* 状态：加载中 */}
        {gameState === 'loading' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 z-20">
            <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-cyan-500 mb-4 shadow-[0_0_20px_rgba(6,182,212,0.5)]"></div>
            <p className="text-xl font-medium animate-pulse text-cyan-400">正在启动视觉引擎...</p>
            <p className="text-sm text-slate-500 mt-2">请允许摄像头权限以进行手势追踪</p>
          </div>
        )}

        {/* 状态：错误 */}
        {gameState === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900 z-20 p-8 text-center">
            <AlertCircle className="w-20 h-20 text-red-500 mb-6" />
            <h2 className="text-2xl font-bold mb-2">出错了</h2>
            <p className="text-slate-300 max-w-md">{errorMessage}</p>
            <button onClick={() => window.location.reload()} className="mt-8 px-6 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg">刷新页面</button>
          </div>
        )}

        {/* 状态：主菜单 (准备就绪) */}
        {gameState === 'ready' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm z-20 animate-in fade-in duration-500">
            <div className="bg-slate-900/90 p-8 md:p-10 rounded-3xl border border-slate-700 text-center max-w-md w-full shadow-2xl">
              <div className="flex justify-center mb-4">
                <div className="bg-cyan-500/10 p-4 rounded-full">
                    <Hand className="w-12 h-12 text-cyan-400 animate-bounce" />
                </div>
              </div>
              <h1 className="text-4xl md:text-5xl font-black mb-6 bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-600 drop-shadow-sm">
                手势切水果
              </h1>
              
              <div className="grid grid-cols-2 gap-3 mb-8 text-sm text-left bg-black/40 p-5 rounded-2xl border border-white/5">
                 <div className="space-y-1">
                    <div className="flex items-center gap-2"><Snowflake size={14} className="text-cyan-400"/> <span className="text-slate-200">切中冰冻减速</span></div>
                    <div className="flex items-center gap-2"><Sparkles size={14} className="text-yellow-400"/> <span className="text-slate-200">切中狂热得分</span></div>
                 </div>
                 <div className="space-y-1">
                    <div className="flex items-center gap-2"><div className="w-3.5 h-3.5 bg-red-500 rounded-full flex items-center justify-center text-[10px]">💣</div> <span className="text-slate-200">切炸弹扣血/分</span></div>
                    <div className="flex items-center gap-2"><Hand size={14} className="text-slate-400"/> <span className="text-slate-200">食指是你的刀</span></div>
                 </div>
              </div>

              <div className="space-y-3">
                  <button 
                    onClick={() => startGame('time')}
                    className="group w-full flex items-center justify-between px-6 py-4 bg-gradient-to-r from-blue-700 to-blue-600 hover:from-blue-600 hover:to-blue-500 text-white rounded-xl transition-all transform hover:scale-[1.02] shadow-lg border border-blue-400/20"
                  >
                    <div className="flex items-center gap-3">
                        <div className="bg-blue-800/50 p-2 rounded-lg group-hover:bg-blue-700/50 transition-colors"><Clock size={20} /></div>
                        <div className="text-left">
                            <div className="text-lg font-bold">限时模式</div>
                            <div className="text-xs text-blue-200/70">60秒积分挑战</div>
                        </div>
                    </div>
                    <Play size={20} className="opacity-0 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0 transition-all" />
                  </button>

                  <button 
                    onClick={() => startGame('survival')}
                    className="group w-full flex items-center justify-between px-6 py-4 bg-gradient-to-r from-rose-700 to-rose-600 hover:from-rose-600 hover:to-rose-500 text-white rounded-xl transition-all transform hover:scale-[1.02] shadow-lg border border-rose-400/20"
                  >
                    <div className="flex items-center gap-3">
                        <div className="bg-rose-800/50 p-2 rounded-lg group-hover:bg-rose-700/50 transition-colors"><Zap size={20} /></div>
                        <div className="text-left">
                            <div className="text-lg font-bold">无尽模式</div>
                            <div className="text-xs text-rose-200/70">3条命，切炸弹扣血</div>
                        </div>
                    </div>
                    <Play size={20} className="opacity-0 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0 transition-all" />
                  </button>
              </div>
            </div>
          </div>
        )}

        {/* 状态：游戏结束 */}
        {gameState === 'finished' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 backdrop-blur-md z-20 animate-in zoom-in duration-300">
            <div className="bg-slate-900 p-8 rounded-3xl border border-slate-700 text-center w-full max-w-md shadow-2xl">
              <div className="inline-block px-4 py-1 bg-yellow-500/20 text-yellow-400 rounded-full text-sm font-bold mb-4 border border-yellow-500/30">
                {gameMode === 'time' ? '⏱️ 时间到' : '💔 生命耗尽'}
              </div>
              
              <h2 className="text-7xl font-black mb-2 text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.3)] tracking-tighter">
                {score}
              </h2>
              <div className="text-slate-400 text-sm mb-8">最终得分</div>
              
              {/* 排行榜 */}
              <div className="bg-black/50 rounded-2xl p-5 mb-8 w-full text-left">
                <h3 className="text-cyan-400 font-bold mb-4 flex items-center gap-2 text-sm uppercase tracking-wider">
                  <Trophy size={16}/> 历史最高 ({gameMode === 'time' ? '限时' : '无尽'})
                </h3>
                <div className="space-y-3">
                  {highScores.filter(s => s.mode === gameMode).slice(0, 3).map((s, i) => (
                    <div key={i} className={`flex justify-between items-center text-sm ${i === 0 ? 'text-yellow-400 font-bold' : 'text-slate-300'}`}>
                      <div className="flex items-center gap-3">
                          <span className={`w-5 h-5 flex items-center justify-center rounded text-xs ${i===0?'bg-yellow-500/20 text-yellow-400': 'bg-slate-700 text-slate-400'}`}>{i + 1}</span>
                          <span className="opacity-60 text-xs">{s.date}</span>
                      </div>
                      <span className="font-mono text-lg">{s.score}</span>
                    </div>
                  ))}
                  {highScores.filter(s => s.mode === gameMode).length === 0 && <div className="text-slate-600 text-center text-xs py-2">暂无当前模式记录</div>}
                </div>
              </div>

              <div className="flex gap-4 justify-center">
                <button 
                  onClick={() => setGameState('ready')}
                  className="flex items-center gap-2 px-8 py-3 bg-slate-700 hover:bg-slate-600 rounded-full font-bold transition-all hover:scale-105"
                >
                  <RotateCcw className="w-5 h-5" /> 返回菜单
                </button>
                <button 
                  onClick={() => startGame(gameMode)}
                  className="flex items-center gap-2 px-8 py-3 bg-cyan-600 hover:bg-cyan-500 text-white rounded-full font-bold transition-all hover:scale-105 shadow-[0_0_20px_rgba(8,145,178,0.4)]"
                >
                  <Play className="w-5 h-5 fill-current" /> 再玩一次
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 text-slate-500 text-xs max-w-lg text-center leading-relaxed">
        <p>基于 MediaPipe 与 TensorFlow.js 构建 • 100% 本地运行保护隐私</p>
        <p className="mt-1 opacity-50">确保您的手部光线充足且背景整洁以获得最佳体验</p>
      </div>
    </div>
  );
};

export default App;
