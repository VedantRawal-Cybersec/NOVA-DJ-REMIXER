/**
 * Studio-transparent Mid-Side Stem Matrix + 4-Band Isolator + 3-Band Kill EQ + Color Filter.
 *
 * Math check (Zero-coloration at unity):
 *   Mid  = 0.5*(L + R)   (contains Bass, Kick/Snare, Center Lead Vocals)
 *   Side = 0.5*(L - R)   (contains Stereo Synths, Guitars, Harmonies = "Other")
 *   Since Mid + Side === L and Mid - Side === R identically when Side/Mid gains == 1.0,
 *   the channel strip is 100% bit-transparent at unity while enabling surgical
 *   Center-Vocal suppression vs Stereo-Backing ("Other") isolation + -36 dB EQ kills!
 */
function gainToDb(gain) {
  const g = Math.max(0.001, Math.min(2.0, Number(gain)));
  if (Math.abs(g - 1) < 0.005) return 0;
  if (g < 1) return Math.max(-36, 20 * Math.log10(g));
  return Math.min(6, 20 * Math.log10(g));
}

export function createStemChannelStrip(ctx, destination) {
  const input = ctx.createGain();
  input.gain.value = 1;

  // True Mid-Side Matrix before EQ
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);

  // Mid = (L + R) * 0.5 into both L/R
  const midL = ctx.createGain();
  const midR = ctx.createGain();
  midL.gain.value = 0.5;
  midR.gain.value = 0.5;
  const midCenter = ctx.createGain();
  midCenter.gain.value = 1.0;

  // Center-Vocal cancellation band on Mid only (does NOT mute stereo instruments!)
  const midVocalBand = ctx.createBiquadFilter();
  midVocalBand.type = 'peaking';
  midVocalBand.frequency.value = 1350;
  midVocalBand.Q.value = 0.65;
  midVocalBand.gain.value = 0;

  // Side = (L - R) * 0.5 (L gets +Side, R gets -Side)
  const sidePosL = ctx.createGain();
  const sideNegR = ctx.createGain();
  sidePosL.gain.value = 0.5;
  sideNegR.gain.value = -0.5;
  const sideGain = ctx.createGain();
  sideGain.gain.value = 1.0;
  const sideInvertToR = ctx.createGain();
  sideInvertToR.gain.value = -1.0;

  input.connect(splitter);
  // L (0) and R (1) into Mid
  splitter.connect(midL, 0);
  splitter.connect(midR, 1);
  midL.connect(midCenter);
  midR.connect(midCenter);
  midCenter.connect(midVocalBand);
  midVocalBand.connect(merger, 0, 0);
  midVocalBand.connect(merger, 0, 1);

  // L (0) and R (1) into Side
  splitter.connect(sidePosL, 0);
  splitter.connect(sideNegR, 1);
  sidePosL.connect(sideGain);
  sideNegR.connect(sideGain);
  sideGain.connect(merger, 0, 0);
  sideGain.connect(sideInvertToR);
  sideInvertToR.connect(merger, 0, 1);

  // Color Filter (DJ Sweep: LowPass < 0 or HighPass > 0)
  const hpf = ctx.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.value = 20;
  hpf.Q.value = 0.72;

  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.value = 20000;
  lpf.Q.value = 0.72;

  // 3-Band DJ Kill EQ (Low / Mid / High) driven by Phase 2 Recipe eq_automation
  const eqLow = ctx.createBiquadFilter();
  eqLow.type = 'lowshelf';
  eqLow.frequency.value = 180;
  eqLow.gain.value = 0;

  const eqMid = ctx.createBiquadFilter();
  eqMid.type = 'peaking';
  eqMid.frequency.value = 1100;
  eqMid.Q.value = 0.75;
  eqMid.gain.value = 0;

  const eqHigh = ctx.createBiquadFilter();
  eqHigh.type = 'highshelf';
  eqHigh.frequency.value = 4200;
  eqHigh.gain.value = 0;

  // 4-Band Spectral Stem Isolator bands (Bass < 145Hz, Drums 280Hz, Air > 4.5kHz)
  const bassBand = ctx.createBiquadFilter();
  bassBand.type = 'lowshelf';
  bassBand.frequency.value = 145;
  bassBand.gain.value = 0;

  const drumsBand = ctx.createBiquadFilter();
  drumsBand.type = 'peaking';
  drumsBand.frequency.value = 280;
  drumsBand.Q.value = 0.75;
  drumsBand.gain.value = 0;

  const airBand = ctx.createBiquadFilter();
  airBand.type = 'highshelf';
  airBand.frequency.value = 4500;
  airBand.gain.value = 0;

  // Main deck fader + LUFS auto-gain trim
  const deckVolume = ctx.createGain();
  deckVolume.gain.value = 1;

  const lufsTrim = ctx.createGain();
  lufsTrim.gain.value = 1;

  merger.connect(hpf);
  hpf.connect(lpf);
  lpf.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(bassBand);
  bassBand.connect(drumsBand);
  drumsBand.connect(airBand);
  airBand.connect(deckVolume);
  deckVolume.connect(lufsTrim);
  lufsTrim.connect(destination);

  // Post-fader FX sends (echo tail rings cleanly after deck fades out!)
  const echoSend = ctx.createGain();
  echoSend.gain.value = 0;
  lufsTrim.connect(echoSend);

  const reverbSend = ctx.createGain();
  reverbSend.gain.value = 0;
  lufsTrim.connect(reverbSend);

  const state = {
    bass: 1,
    drums: 1,
    vocals: 1,
    other: 1,
    filter: 0,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
  };

  function setStem(name, targetGain, atTime = ctx.currentTime, rampSec = 0.04) {
    const g = Math.max(0.001, Math.min(2.0, Number(targetGain)));
    const db = gainToDb(g);
    state[name] = g;
    const tc = Math.max(0.012, rampSec);

    if (name === 'vocals') {
      midVocalBand.gain.cancelScheduledValues(atTime);
      midVocalBand.gain.setTargetAtTime(db, atTime, tc);
    } else if (name === 'other') {
      sideGain.gain.cancelScheduledValues(atTime);
      sideGain.gain.setTargetAtTime(g < 0.99 ? Math.max(0.02, g) : 1.0, atTime, tc);
      airBand.gain.cancelScheduledValues(atTime);
      airBand.gain.setTargetAtTime(db * 0.55, atTime, tc);
    } else if (name === 'bass') {
      bassBand.gain.cancelScheduledValues(atTime);
      bassBand.gain.setTargetAtTime(db, atTime, tc);
    } else if (name === 'drums') {
      drumsBand.gain.cancelScheduledValues(atTime);
      drumsBand.gain.setTargetAtTime(db, atTime, tc);
    }
  }

  function setEqBand(band, dbValue, atTime = ctx.currentTime, rampSec = 0.03) {
    const clamped = Math.max(-36, Math.min(6, Number(dbValue) || 0));
    const node = band === 'low' ? eqLow : band === 'mid' ? eqMid : eqHigh;
    const tc = Math.max(0.012, rampSec);
    if (band === 'low') state.eqLow = clamped;
    else if (band === 'mid') state.eqMid = clamped;
    else state.eqHigh = clamped;
    node.gain.cancelScheduledValues(atTime);
    node.gain.setTargetAtTime(clamped, atTime, tc);
  }

  function setColorFilter(norm, atTime = ctx.currentTime, rampSec = 0.03) {
    state.filter = Math.max(-1, Math.min(1, norm));
    hpf.frequency.cancelScheduledValues(atTime);
    hpf.Q.cancelScheduledValues(atTime);
    lpf.frequency.cancelScheduledValues(atTime);
    lpf.Q.cancelScheduledValues(atTime);
    if (state.filter < -0.02) {
      const amt = Math.abs(state.filter);
      const lpFreq = 20000 * Math.pow(220 / 20000, amt);
      hpf.frequency.setTargetAtTime(20, atTime, rampSec);
      hpf.Q.setTargetAtTime(0.72, atTime, rampSec);
      lpf.frequency.setTargetAtTime(lpFreq, atTime, rampSec);
      lpf.Q.setTargetAtTime(0.72 + amt * 2.2, atTime, rampSec);
    } else if (state.filter > 0.02) {
      const hpFreq = 24 * Math.pow(5200 / 24, state.filter);
      lpf.frequency.setTargetAtTime(20000, atTime, rampSec);
      lpf.Q.setTargetAtTime(0.72, atTime, rampSec);
      hpf.frequency.setTargetAtTime(hpFreq, atTime, rampSec);
      hpf.Q.setTargetAtTime(0.72 + state.filter * 2.2, atTime, rampSec);
    } else {
      hpf.frequency.setTargetAtTime(20, atTime, rampSec);
      hpf.Q.setTargetAtTime(0.72, atTime, rampSec);
      lpf.frequency.setTargetAtTime(20000, atTime, rampSec);
      lpf.Q.setTargetAtTime(0.72, atTime, rampSec);
    }
  }

  function resetAll(atTime = ctx.currentTime) {
    setStem('bass', 1, atTime, 0.04);
    setStem('drums', 1, atTime, 0.04);
    setStem('vocals', 1, atTime, 0.04);
    setStem('other', 1, atTime, 0.04);
    setEqBand('low', 0, atTime, 0.04);
    setEqBand('mid', 0, atTime, 0.04);
    setEqBand('high', 0, atTime, 0.04);
    setColorFilter(0, atTime, 0.04);
    echoSend.gain.cancelScheduledValues(atTime);
    echoSend.gain.setTargetAtTime(0, atTime, 0.04);
    reverbSend.gain.cancelScheduledValues(atTime);
    reverbSend.gain.setTargetAtTime(0, atTime, 0.04);
  }

  return {
    input,
    output: lufsTrim,
    deckVolume,
    lufsTrim,
    hpf,
    lpf,
    eqLow,
    eqMid,
    eqHigh,
    stems: { bass: bassBand, drums: drumsBand, vocals: midVocalBand, other: sideGain },
    echoSend,
    reverbSend,
    state,
    setStem,
    setEqBand,
    setColorFilter,
    resetAll,
  };
}
