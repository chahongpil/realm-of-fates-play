// 80_fx.js — extracted by docs/_split_modules.py (Phase 5)
// FX module assigned to RoF namespace.

// 2026-04-27: 번개 갈래(bolts) + 화면 flash 폐기 (사용자 결정). 잿불(embers) 입자만 유지.
RoF.FX ={
  canvas:null,ctx:null,particles:[],_raf:null,_resizeHandler:null,

  initTitle(){
    this.destroy();
    const screen=document.getElementById('title-screen');if(!screen)return;
    const c=document.createElement('canvas');c.id='title-fx';
    // 2026-05-02: body 직계 + fixed viewport 풀 (transform:scale 된 game-root 영향 회피).
    //   이전: title-screen 안 → game-root 의 transform 따라 letterbox 영역(좌우 ~378px) 안 닿음 → 세로 띠 경계.
    c.style.cssText='position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:0;';
    c.width=window.innerWidth;c.height=window.innerHeight;
    document.body.appendChild(c);
    this.canvas=c;this.ctx=c.getContext('2d');
    // 2026-05-02: viewport resize 시 canvas drawing buffer 도 동기화 (DevTools 토글·창 크기 변경 대응)
    this._resizeHandler=()=>{
      if(!this.canvas)return;
      this.canvas.width=window.innerWidth;
      this.canvas.height=window.innerHeight;
    };
    window.addEventListener('resize',this._resizeHandler);
    this.particles=[];
    // Create embers
    for(let i=0;i<50;i++){
      this.particles.push({
        x:Math.random()*c.width,y:c.height+Math.random()*100,
        speed:0.3+Math.random()*1.5,drift:(Math.random()-.5)*.5,
        size:1+Math.random()*3,alpha:0.3+Math.random()*.5,
        color:Math.random()>.5?'255,100,30':'255,170,60',
      });
    }
    this._loop();
  },

  _loop(){
    if(!this.ctx)return;
    const c=this.canvas,ctx=this.ctx;
    ctx.clearRect(0,0,c.width,c.height);

    // Draw embers
    this.particles.forEach(p=>{
      p.y-=p.speed;p.x+=p.drift+Math.sin(p.y*.01)*.3;
      p.alpha-=0.002;
      if(p.y<-20||p.alpha<=0){p.y=c.height+10;p.x=Math.random()*c.width;p.alpha=0.3+Math.random()*.5;}
      ctx.beginPath();ctx.arc(p.x,p.y,p.size,0,Math.PI*2);
      ctx.fillStyle=`rgba(${p.color},${p.alpha})`;ctx.fill();
      // Glow
      ctx.beginPath();ctx.arc(p.x,p.y,p.size*3,0,Math.PI*2);
      ctx.fillStyle=`rgba(${p.color},${p.alpha*.2})`;ctx.fill();
    });

    this._raf=requestAnimationFrame(()=>this._loop());
  },

  destroy(){
    if(this._raf)cancelAnimationFrame(this._raf);this._raf=null;
    if(this._resizeHandler){window.removeEventListener('resize',this._resizeHandler);this._resizeHandler=null;}
    this.ctx=null;this.particles=[];
    const c=document.getElementById('title-fx');if(c)c.remove();
  }
};

// Expose as global for inline onclick="FX.foo()" bindings and Game cross-refs.
window.FX = RoF.FX;