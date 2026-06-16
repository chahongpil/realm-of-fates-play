'use strict';

// Phase 3: SFX → RoF.SFX (+ window.SFX 호환)
// ============ SOUND (Web Audio API — Enhanced) ============
RoF.SFX={
  ctx:null,on:false,vol:.5,
  init(){if(this.ctx)return;try{this.ctx=new(window.AudioContext||window.webkitAudioContext)();
    // Master volume
    this.master=this.ctx.createGain();this.master.gain.value=this.vol;this.master.connect(this.ctx.destination);
    // Reverb (convolver simulation with delay)
    this.reverb=this.ctx.createGain();this.reverb.gain.value=.3;this.reverb.connect(this.master);
    // 사용자 mute 영구 설정 존중 — localStorage rof8_user_muted='1' 이면 on=false 유지.
    const userMuted=localStorage.getItem('rof8_user_muted')==='1';
    this.on=!userMuted;document.getElementById('sound-toggle').textContent=userMuted?'🔇':'🔊';}catch(e){}},
  toggle(){
    // ctx 없으면 첫 클릭 — init 후 켜진 상태로 시작 (mute 의도 아니면 켜기가 자연스러움)
    if(!this.ctx){this.init();this.on=true;localStorage.setItem('rof8_user_muted','0');document.getElementById('sound-toggle').textContent='🔊';this._bgmStarted=true;this.bgm(this._currentGroup||'title');return;}
    this.on=!this.on;
    localStorage.setItem('rof8_user_muted',this.on?'0':'1');
    document.getElementById('sound-toggle').textContent=this.on?'🔊':'🔇';
    if(!this.on){
      if(this._bgmAudio)this._bgmAudio.pause();
    } else {
      // 켜기 — 이미 audio 가 있으면 resume, 없으면 (mute 로 시작해서 _bgmAudio=null 인 케이스) BGM 새로 시작
      if(this._bgmAudio){
        this._bgmAudio.play().catch(()=>{});
      } else {
        this.bgm(this._currentGroup||'title');
      }
    }
  },
  setVolume(v){
    const vol=parseInt(v)/100;
    this.vol=vol;
    if(this.master)this.master.gain.value=vol;
    if(this._bgmAudio)this._bgmAudio.volume=vol;
    document.getElementById('vol-display').textContent=v;
    document.getElementById('sound-toggle').textContent=vol===0?'🔇':vol<.3?'🔉':'🔊';
    localStorage.setItem('rof8_vol',v);// 볼륨 저장
  },
  // Helper: create oscillator+gain connected to master
  _osc(type,freq,vol,start,dur){
    const c=this.ctx,o=c.createOscillator(),g=c.createGain();
    o.type=type;o.frequency.setValueAtTime(freq,start);
    g.gain.setValueAtTime(vol,start);g.gain.exponentialRampToValueAtTime(.001,start+dur);
    o.connect(g);g.connect(this.master);o.start(start);o.stop(start+dur+.01);return{o,g};
  },
  // Helper: noise burst (percussion)
  _noise(vol,start,dur){
    const c=this.ctx,buf=c.createBuffer(1,c.sampleRate*dur,c.sampleRate);
    const d=buf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1);
    const s=c.createBufferSource();s.buffer=buf;
    const g=c.createGain();g.gain.setValueAtTime(vol,start);g.gain.exponentialRampToValueAtTime(.001,start+dur);
    const f=c.createBiquadFilter();f.type='highpass';f.frequency.value=1000;
    s.connect(f);f.connect(g);g.connect(this.master);s.start(start);
  },
  // Helper: chord (multiple notes)
  _chord(type,notes,vol,start,dur){notes.forEach(n=>this._osc(type,n,vol/notes.length,start,dur));},

  play(type){
    if(!this.on||!this.ctx)return;
    const c=this.ctx,t=c.currentTime;
    if(type==='click'){this._osc('sine',880,.04,t,.06);this._osc('sine',1320,.02,t,.04);}
    else if(type==='slash'){
      this._noise(.15,t,.12);this._osc('sawtooth',300,.1,t,.05);
      this._osc('sawtooth',150,.08,t+.05,.1);
    }
    else if(type==='magic'){
      this._osc('sine',600,.08,t,.1);this._osc('sine',900,.06,t+.05,.15);
      this._osc('triangle',1200,.05,t+.1,.2);this._osc('sine',800,.04,t+.2,.15);
    }
    else if(type==='heal'){
      [400,500,600,800].forEach((n,i)=>this._osc('sine',n,.06,t+i*.08,.3));
      this._osc('triangle',1200,.03,t+.2,.4);
    }
    else if(type==='hit'){
      this._noise(.2,t,.08);this._osc('square',100,.12,t,.08);
      this._osc('square',60,.08,t+.03,.06);
    }
    else if(type==='crit'){
      this._noise(.25,t,.15);this._osc('sawtooth',200,.15,t,.08);
      this._osc('sawtooth',400,.1,t+.05,.1);this._osc('square',100,.12,t,.1);
      this._osc('sine',800,.06,t+.1,.2);
    }
    else if(type==='death'){
      this._osc('sawtooth',200,.1,t,.15);this._osc('sawtooth',100,.08,t+.1,.2);
      this._osc('sawtooth',50,.06,t+.2,.3);this._noise(.06,t,.1);
      this._osc('sine',150,.05,t+.3,.3);
    }
    else if(type==='victory'){this._chord('sine',[523.25,659.25,783.99],.1,t,.3);this._chord('sine',[659.25,783.99,1046.5],.1,t+.3,.5);}
    else if(type==='upgrade'){
      [400,500,600,800,1000].forEach((n,i)=>this._osc('triangle',n,.06,t+i*.06,.2));
    }
    else if(type==='rarity_up'){
      [300,400,500,600,800,1000,1200].forEach((n,i)=>this._osc('sine',n,.05,t+i*.08,.3));
      this._chord('triangle',[600,900,1200],.06,t+.4,.5);
      this._noise(.04,t+.5,.1);
    }
    else if(type==='card_reveal'){
      this._osc('triangle',500,.07,t,.1);this._osc('triangle',700,.06,t+.1,.1);
      this._osc('sine',1000,.05,t+.15,.2);
    }
    else if(type==='fanfare'){
      // Triumphant brass-like chord progression: C-E-G → D-F#-A → E-G#-B → C-E-G(high)
      this._chord('sawtooth',[261.63,329.63,392],.06,t,.4);
      this._chord('sawtooth',[293.66,369.99,440],.07,t+.35,.4);
      this._chord('sawtooth',[329.63,415.3,493.88],.08,t+.7,.4);
      this._chord('sine',[523.25,659.25,783.99],.08,t+1,.6);
      this._noise(.03,t,.05);this._noise(.03,t+.35,.05);this._noise(.04,t+.7,.05);this._noise(.05,t+1,.08);
    }
    else if(type==='build'){
      // Hammering + rising tone
      for(let i=0;i<4;i++){this._noise(.08,t+i*.15,.06);this._osc('square',80+i*20,.06,t+i*.15,.08);}
      this._chord('sine',[400,500,600],.05,t+.6,.4);
    }
  },
  bgmNodes:[],_bgmTimers:[],_bgmAudio:null,_currentGroup:null,
  _drone(ty,f,v){const c=this.ctx,o=c.createOscillator(),g=c.createGain();o.type=ty;o.frequency.value=f;g.gain.value=v;o.connect(g);g.connect(this.master);o.start();this.bgmNodes.push(o);},

  // MP3 BGM tracks
  // 2026-05-02: title4 (hitslab gospel worship) — title + town 풀 양쪽 등록 (사용자 결정).
  _titleTracks:['snd/title1.mp3','snd/title2.mp3','snd/title3.mp3','snd/title4.mp3'],
  _townTracks:['snd/town1.mp3','snd/town2.mp3','snd/town3.mp3','snd/town4.mp3','snd/town5.mp3','snd/title4.mp3'],
  _battleTracks:['snd/battle1.mp3','snd/battle2.mp3','snd/battle3.mp3','snd/battle4.mp3','snd/battle5.mp3','snd/battle6.mp3'],

  _stopBgm(){
    // Stop MP3
    if(this._bgmAudio){this._bgmAudio.pause();this._bgmAudio.currentTime=0;this._bgmAudio=null;}
    // Stop Web Audio
    this.bgmNodes.forEach(n=>{try{n.stop();}catch(e){}});this.bgmNodes=[];
    this._bgmTimers.forEach(t=>clearInterval(t));this._bgmTimers=[];
  },

  _playMp3(tracks,volOverride,avoidIdx){
    // mute 상태에서 어떤 경로로든 audio.play() 호출되는 걸 막는 최후 가드.
    if(!this.on)return;
    // 트랙 1개면 무한 루프(audio.loop=true 이음매 없음), 2개 이상이면 셔플 플레이리스트.
    let idx=Math.floor(Math.random()*tracks.length);
    if(tracks.length>1&&idx===avoidIdx){idx=(idx+1)%tracks.length;}
    const src=tracks[idx];
    const audio=new Audio(src);
    audio.volume=volOverride||this.vol||0.4;
    if(tracks.length<=1){
      audio.loop=true;
    } else {
      audio.loop=false;
      audio.onended=()=>{
        // 현재 _bgmAudio 가 자신일 때만 다음 곡 (타입 전환 중이면 멈춤)
        if(this._bgmAudio===audio&&this.on){this._playMp3(tracks,volOverride,idx);}
      };
    }
    audio.play().catch(()=>{});
    this._bgmAudio=audio;
  },

  bgm(type){
    if(!this.ctx)this.init();

    // 2026-04-27: 3 그룹 정규화 (title / town / battle). 같은 그룹 + 재생 중이면 noop —
    // 마을 안 건물 이동(showTavern 등) 또는 마을 복귀(showMenu 재호출) 시 음악 끊기지 않음.
    let group=null;
    if(type==='title') group='title';
    else if(type==='town'||type==='menu') group='town';
    else if(type==='battle'||type==='match') group='battle';
    if(group && this._currentGroup===group && this._bgmAudio && !this._bgmAudio.paused) return;

    this._stopBgm();
    if(!type||!this.on){this._currentGroup=null;return;}
    this._currentGroup=group;
    const c=this.ctx;

    // ═══ MP3 BGM ═══
    if(type==='title'){this._playMp3(this._titleTracks);return;}
    if(type==='town'||type==='menu'){this._playMp3(this._townTracks);return;}
    if(type==='battle'||type==='match'){this._playMp3(this._battleTracks);return;}// match 도 battle 그룹 동일 처리 (볼륨 25% override 폐기)

    // ═══ Web Audio fallback ═══
    if(type==='menu'||type==='title'){
      // ═══ TITLE/MENU: 장엄한 오르간 + 성가 코드 진행 ═══
      // Deep organ drone: C2 + G2
      this._drone('sine',65.41,.015);this._drone('triangle',98,.01);this._drone('sine',130.81,.008);
      // Slow majestic chord progression: Cm → Ab → Eb → Bb → Cm
      const chords=[[130.81,155.56,196],[207.65,261.63,311.13],[155.56,196,261.63],[116.54,146.83,174.61]];
      let ci=0;
      this._bgmTimers.push(setInterval(()=>{
        if(!this.on)return;const t=c.currentTime;
        const ch=chords[ci%chords.length];
        ch.forEach(f=>{this._osc('sine',f,.02,t,3);this._osc('triangle',f*2,.008,t,.5,2.5);});
        // High ethereal shimmer
        this._osc('sine',ch[2]*4,.006,t+.5,2);
        ci++;
      },3500));
      // Mysterious bell
      this._bgmTimers.push(setInterval(()=>{
        if(!this.on)return;const t=c.currentTime;
        const f=[523.25,659.25,783.99,1046.5][Math.floor(Math.random()*4)];
        this._osc('sine',f,.012,t,.08);this._osc('sine',f,.008,t+.08,1.5);
      },4200));

    } else if(type==='town'){
      // ═══ TOWN: 3곡 랜덤 — 중세 판타지 ═══
      const track=Math.floor(Math.random()*4);

      if(track===0){
        // ── Track 1: Baba Yetu 스타일 (웅장한 합창 + 아프리칸 퍼커션) ──
        // Deep bass drone: C2 + G2
        this._drone('sine',65.41,.018);this._drone('triangle',98,.01);
        // African percussion pattern (djembe feel)
        let dp=0;
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on)return;const t=c.currentTime;
          const pat=[.12,.04,.08,.04,.1,.04,.06,.08];const vol=pat[dp%pat.length];
          this._osc('sine',80,vol,t,.06);// low djembe
          if(dp%2===1)this._noise(vol*.5,t,.03);// high slap
          if(dp%8===0){this._osc('sine',50,.1,t,.1);this._noise(.04,t,.08);}// big boom
          if(dp%4===2)this._osc('sine',120,.03,t,.04);// mid tone
          dp++;
        },220));
        // Choir chords — building progression: C → Am → F → G → C → Am → Dm → G
        const choir=[[261.63,329.63,392],[220,261.63,329.63],[174.61,220,261.63],[196,246.94,293.66],
                      [261.63,329.63,392],[220,261.63,329.63],[146.83,174.61,220],[196,246.94,293.66]];
        let chi=0;
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on)return;const t=c.currentTime;
          const ch=choir[chi%choir.length];
          const vol=.012+Math.min(chi*.001,.015);// gradually louder
          ch.forEach(f=>{
            this._osc('sine',f,vol,t,3.2);
            this._osc('triangle',f,vol*.5,t+.1,3);
            this._osc('sine',f*2,vol*.3,t+.2,2.5);// upper octave
          });
          // Bass movement
          this._osc('sine',ch[0]/2,vol*.8,t,3);
          chi++;
        },3500));
        // Call melody (solo voice — pentatonic C)
        const call=[523.25,587.33,659.25,783.99,659.25,523.25,587.33,659.25,783.99,1046.5,783.99,659.25,523.25,392,523.25,659.25];
        let cli=0;
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on)return;const t=c.currentTime;
          const f=call[cli%call.length];
          this._osc('sine',f,.02,t,1.2);
          this._osc('sine',f*1.003,.01,t+.02,1);// slight chorus
          // Response (echo, quieter, delayed)
          if(cli%4===3)this._osc('sine',f*.5,.008,t+.4,1.5);
          cli++;
        },700));
        // Shaker (constant 16th)
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on)return;this._noise(.01,c.currentTime,.02);
        },220));

      } else if(track===1){
        // ── Track 2: 중세 선술집 (류트 + 타악기 + 피들) ──
        this._drone('triangle',110,.015);this._drone('triangle',165,.01);
        const lute=[[220,261.63,329.63],[196,246.94,293.66],[174.61,220,261.63],[164.81,207.65,246.94]];
        let li=0;
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on)return;const t=c.currentTime;
          const ch=lute[li%lute.length];
          ch.forEach((f,i)=>{this._osc('triangle',f,.03,t+i*.04,.4);this._osc('triangle',f*2,.01,t+i*.04+.05,.3);});
          li++;
        },800));
        const fiddle=[440,523.25,587.33,659.25,587.33,523.25,440,392,440,493.88,523.25,587.33,659.25,783.99,659.25,523.25];
        let fdi=0;
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on)return;const t=c.currentTime;
          const f=fiddle[fdi%fiddle.length];
          this._osc('sawtooth',f,.018,t,.2);this._osc('sine',f,.012,t+.02,.25);
          fdi++;
        },350));
        this._bgmTimers.push(setInterval(()=>{if(!this.on)return;this._noise(.025,c.currentTime,.04);},400));
        let bd=0;
        this._bgmTimers.push(setInterval(()=>{if(!this.on)return;if(bd%2===0)this._osc('sine',55,.04,c.currentTime,.08);bd++;},800));

      } else if(track===2){
        // ── Track 2: 장엄한 성가 (오르간 + 합창 + 종) ──
        this._drone('sine',65.41,.02);this._drone('triangle',98,.012);this._drone('sine',130.81,.01);
        // Choir chords: Cm → Fm → G → Cm (slower, grander)
        const choir=[[130.81,155.56,196],[174.61,207.65,261.63],[196,246.94,293.66],[130.81,155.56,196]];
        let chi=0;
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on)return;const t=c.currentTime;
          const ch=choir[chi%choir.length];
          ch.forEach(f=>{
            this._osc('sine',f,.025,t,3.5);
            this._osc('triangle',f,.015,t+.1,3);
            this._osc('sine',f*2,.008,t+.3,2.5);
            this._osc('sine',f*3,.003,t+.5,2);// overtone
          });
          chi++;
        },4000));
        // Solo voice melody (high sine, expressive)
        const voice=[523.25,587.33,659.25,783.99,659.25,587.33,523.25,493.88,523.25,659.25,783.99,1046.5,783.99,659.25];
        let vi=0;
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on)return;const t=c.currentTime;
          this._osc('sine',voice[vi%voice.length],.015,t,1.8);
          this._osc('sine',voice[vi%voice.length]*1.005,.008,t,.5,1.5);// chorus effect
          vi++;
        },2000));
        // Church bells
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on)return;const t=c.currentTime;
          const f=[261.63,392,523.25][Math.floor(Math.random()*3)];
          this._osc('sine',f,.015,t,.05);this._osc('sine',f,.01,t+.05,2);this._osc('sine',f*.5,.005,t+.1,2.5);
        },5000));

      } else {
        // ── Track 3: 신비로운 숲 (하프 + 플루트 + 자연) ──
        this._drone('sine',130.81,.01);this._drone('sine',196,.008);this._drone('triangle',261.63,.004);
        // Harp arpeggio (C major, flowing)
        const harp=[261.63,329.63,392,523.25,659.25,783.99,659.25,523.25,392,329.63];
        let hi=0;
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on)return;const t=c.currentTime;
          const f=harp[hi%harp.length];
          this._osc('sine',f,.03,t,.8);
          this._osc('triangle',f*2,.008,t+.05,1);
          if(hi%5===0)this._osc('sine',f/2,.01,t,1.2);// bass note
          hi++;
        },500));
        // Flute melody (pentatonic, dreamy)
        const flute=[523.25,659.25,783.99,1046.5,783.99,659.25,523.25,392,523.25,659.25,783.99,523.25];
        let fli=0;
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on)return;const t=c.currentTime;
          const f=flute[fli%flute.length];
          this._osc('sine',f,.018,t,2.5);
          this._osc('sine',f*1.003,.008,t,.1,2);// vibrato
          fli++;
        },1800));
        // Bird chirps
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on||Math.random()>.35)return;const t=c.currentTime;
          const f=1800+Math.random()*1200;
          this._osc('sine',f,.01,t,.04);this._osc('sine',f*1.3,.007,t+.06,.03);
          if(Math.random()>.5)this._osc('sine',f*.8,.005,t+.12,.03);
        },1500));
        // Gentle stream (filtered noise)
        this._bgmTimers.push(setInterval(()=>{
          if(!this.on)return;this._noise(.008,c.currentTime,.3);
        },600));
      }

    } else if(type==='battle'){
      // ═══ BATTLE: 2곡 랜덤 ═══
      // ── Battle: 웅장한 전쟁 합창 (Baba Yetu 전투 버전) ──
      // Deep war bass: Dm
      this._drone('sine',73.42,.02);this._drone('triangle',110,.012);this._drone('sine',146.83,.008);
      // Epic war drums (tribal + orchestral)
      let db=0;
      this._bgmTimers.push(setInterval(()=>{
        if(!this.on)return;const t=c.currentTime;
        const pat=[.18,.05,.08,.15,.05,.12,.05,.08,.16,.05,.06,.1];
        const vol=pat[db%pat.length];
        this._osc('sine',45,vol,t,.08);// deep kick
        this._osc('sine',55,vol*.5,t+.02,.06);// sub
        if(db%3===1)this._noise(vol*.6,t,.04);// snare
        if(db%3===2)this._noise(vol*.3,t,.02);// ghost
        if(db%12===0){this._osc('sine',35,.12,t,.12);this._noise(.06,t,.15);}// crash boom
        if(db%6===3)this._osc('sine',100,.04,t,.03);// tom
        db++;
      },190));
      // War choir: Dm → Gm → Bb → A → Dm (epic progression)
      const choir=[[146.83,174.61,220],[196,233.08,293.66],[233.08,293.66,349.23],[220,277.18,329.63],
                    [146.83,174.61,220],[196,233.08,293.66],[174.61,220,261.63],[220,277.18,329.63]];
      let chi=0;
      this._bgmTimers.push(setInterval(()=>{
        if(!this.on)return;const t=c.currentTime;
        const ch=choir[chi%choir.length];
        const vol=.015+Math.min(chi*.001,.02);
        ch.forEach(f=>{
          this._osc('sine',f,vol,t,3);
          this._osc('triangle',f,vol*.6,t+.05,2.8);
          this._osc('sine',f*2,vol*.35,t+.15,2.5);// high octave
          this._osc('sine',f*3,vol*.1,t+.3,2);// overtone
        });
        this._osc('sine',ch[0]/2,vol,t,3);// bass root
        chi++;
      },3200));
      // Heroic melody (call to battle)
      const hero=[293.66,349.23,440,523.25,440,349.23,293.66,261.63,293.66,349.23,440,587.33,523.25,440,349.23,293.66];
      let hi=0;
      this._bgmTimers.push(setInterval(()=>{
        if(!this.on)return;const t=c.currentTime;
        const f=hero[hi%hero.length];
        this._osc('sawtooth',f,.022,t,.28);
        this._osc('sine',f,.015,t+.02,.25);
        this._osc('triangle',f*2,.006,t+.05,.2);// bright overtone
        if(hi%4===0)this._osc('sawtooth',f*.5,.008,t,.2);// bass accent
        hi++;
      },280));
      // Tension strings (high tremolo)
      this._bgmTimers.push(setInterval(()=>{
        if(!this.on)return;const t=c.currentTime;
        const f=587.33+Math.random()*200;
        for(let i=0;i<5;i++)this._osc('sine',f,.004,t+i*.035,.04);
      },600));
      // Cymbal crashes on phrase changes
      this._bgmTimers.push(setInterval(()=>{
        if(!this.on)return;this._noise(.03,c.currentTime,.2);
      },3200));

    } else if(type==='match'){
      // ═══ MATCHMAKING: 긴장감 있는 대기 ═══
      this._drone('sine',82.41,.01);this._drone('triangle',123.47,.006);
      // Suspenseful pulse
      let si=0;
      this._bgmTimers.push(setInterval(()=>{
        if(!this.on)return;const t=c.currentTime;
        this._osc('sine',82.41*(si%2?1.5:1),.02,t,.15);
        this._noise(.015,t,.03);
        si++;
      },600));
      // Eerie high tone
      this._bgmTimers.push(setInterval(()=>{
        if(!this.on)return;const t=c.currentTime;
        const f=800+Math.random()*400;
        this._osc('sine',f,.006,t,2);
      },3000));
    }
  }
};

// 호환성 레이어
window.SFX = RoF.SFX;

// ── Auto-init sound on first user gesture (browser requires user gesture) ──
// Phase 3 Opus 리뷰 반영: IIFE bindGesture
(function bindGesture() {
  const events = ['click', 'touchstart', 'keydown'];
  const init = () => {
    RoF.SFX.init();
    if (!RoF.SFX._bgmStarted) {
      RoF.SFX._bgmStarted = true;
      RoF.SFX.bgm('title');
    }
    events.forEach(e => document.removeEventListener(e, init, true));
  };
  events.forEach(e => document.addEventListener(e, init, true));
})();

// 2026-04-21: iframe(편집기 미리보기) · Playwright(자동화 테스트)에서는 음악·효과음 완전 차단.
// 중첩 재생 / 테스트 노이즈 방지. 모든 메서드를 no-op 으로 교체, 비함수 필드는 유지.
// 감지 수단 (하나라도 해당하면 mute):
//   - iframe 안 (편집기 미리보기)
//   - navigator.webdriver (표준 WebDriver)
//   - URL ?mute=1 쿼리
//   - localStorage rof8_mute === '1'
//   - navigator.userAgent 에 HeadlessChrome/Playwright
(function(){
  let mute = false;
  try {
    if (window.self !== window.top) mute = true;
    else if (navigator && navigator.webdriver) mute = true;
    else if (/(?:\?|&)mute=1(?:&|$)/.test(location.search || '')) mute = true;
    else if (localStorage.getItem('rof8_mute') === '1') mute = true;
    else if (/HeadlessChrome|Playwright/i.test((navigator && navigator.userAgent) || '')) mute = true;
  } catch(e) { mute = true; }
  if (!mute) return;
  const S = RoF.SFX;
  for (const k in S) {
    if (typeof S[k] === 'function') S[k] = function(){};
  }
  S.on = false;
  // 이미 초기화됐을 가능성도 처리 — 오디오 정지
  try { if (S._bgmAudio) { S._bgmAudio.pause(); S._bgmAudio = null; } } catch(e){}
  try { if (S.master) S.master.gain.value = 0; } catch(e){}
})();
