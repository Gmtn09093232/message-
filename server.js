'use strict';

/**
 * Engineering Cost Estimator V6 – Complete Backend
 * Supports extended BOQ/MPP fields and file uploads for drawings.
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

let createClient = null;
try { ({ createClient } = require('@supabase/supabase-js')); } catch (_) {}

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// -------- Utility functions --------
const num = (v, d = 0) => {
  if (v === null || v === undefined || v === '') return d;
  if (typeof v === 'number') return Number.isFinite(v) ? v : d;
  const n = Number(String(v).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : d;
};
const pct = v => num(v) / 100;
const round = (v, digits = 2) => {
  const p = 10 ** digits;
  return Math.round((num(v) + Number.EPSILON) * p) / p;
};
const clean = v => String(v ?? '').trim();
const lower = v => clean(v).toLowerCase();
const sum = xs => xs.reduce((a, b) => a + num(b), 0);
const safe = (fn, fallback = null) => { try { return fn(); } catch (_) { return fallback; } };

// -------- Excel formulas (migrated) --------
const EXCEL_FORMULAS = Object.freeze({
  price_estimation: {
    H10: 'H11+H12',
    H11: "'Direct raw material cost'!J10+'Casting parts'!J8",
    H12: "'standard parts cost'!H8",
    H13: 'H10*0.07',
    H14: "'Amimtde DLC and OHC'!E41",
    H15: "'Machining cost '!W9",
    H16: "'Service cost'!L3",
    H17: "'Amimtde DLC and OHC'!H24",
    H18: "'Amimtde DLC and OHC'!H15",
    H19: 'H10+H13+H14+H15+H16+H17+H18'
  },
  direct_raw_material: {
    J10: 'SUMIF(I11:I160,">0")*0.85',
    I11: 'H11*G11*F11',
    H11: 'LOOKUP(C11,L11:L300,U11:U300)',
    D11: 'LOOKUP(C11,L11:L300,M11:M300)'
  },
  standard_parts: {
    H8: 'SUM(G9:G45)*0.85',
    G9: 'F9*D9'
  },
  pattern_making: { H5: 'SUMIF(G6:G24,">0")/60' },
  assembly: { G5: '(F6+F7+F9+F8+F11+F12+F13)/60' },
  quality_control: { F3: 'SUM(E4:E9)/60' },
  service: {
    L3: 'F10+F16+F26+E32',
    F10: 'N7+M9',
    F16: 'M13+I15',
    F26: 'M25+M22+M19',
    F32: 'M29+L31'
  }
});

// -------- Core calculation engines --------
function materialWeight(opts = {}) {
  const { shape, densityKgM3 = 7850, lengthMm, widthMm, thicknessMm, diameterMm, outerDiameterMm, innerDiameterMm, quantity = 1 } = opts;
  const L = num(lengthMm) / 1000;
  const W = num(widthMm) / 1000;
  const T = num(thicknessMm) / 1000;
  const D = num(diameterMm) / 1000;
  const OD = num(outerDiameterMm) / 1000;
  const ID = num(innerDiameterMm) / 1000;
  let volume = 0;
  switch (lower(shape)) {
    case 'plate': case 'sheet': case 'flat':
      volume = L * W * T; break;
    case 'bar': case 'rod':
      volume = Math.PI * D * D / 4 * L; break;
    case 'cylinder': case 'round':
      volume = Math.PI * D * D / 4 * L; break;
    case 'pipe': case 'tube':
      volume = Math.PI * (OD * OD - ID * ID) / 4 * L; break;
    case 'box': case 'block': case 'rectangular':
      volume = L * W * T; break;
    case 'custom':
      volume = num(opts.volumeM3); break;
    default:
      volume = L * W * T;
  }
  const per = volume * num(densityKgM3);
  return { volumeM3: volume, weightKgPerPart: per, totalWeightKg: per * num(quantity, 1) };
}

function calculateEngineeringEstimate(input = {}) {
  const s = input.settings || {};
  const parts = Array.isArray(input.parts) ? input.parts : [];
  const materials = Array.isArray(input.materials) ? input.materials : [];
  const castings = Array.isArray(input.castings) ? input.castings : [];
  const standardParts = Array.isArray(input.standardParts) ? input.standardParts : [];
  const operations = Array.isArray(input.operations) ? input.operations : [];
  const labour = Array.isArray(input.labour) ? input.labour : [];
  const services = Array.isArray(input.services) ? input.services : [];

  const rawMaterial = sum(materials.map(x => num(x.weightKg ?? x.weight) * num(x.unitCost ?? x.etbPerKg) * num(x.qty, 1)));
  const casting = sum(castings.map(x => num(x.weightKg ?? x.weight) * num(x.unitCost ?? x.costPerKg) * num(x.qty, 1)));
  const standard = sum(standardParts.map(x => num(x.qty, 1) * num(x.unitPrice ?? x.unitCost)));
  const materialBase = rawMaterial + casting;

  const materialOHRate = s.excelMaterialOH === undefined ? 0.07 : pct(s.excelMaterialOH);
  const materialOH = materialBase * materialOHRate;

  const designLabour = num(input.designLabourCost ?? s.designLabourCost);
  const directLabour = labour.length
    ? sum(labour.map(x => num(x.hours) * num(x.rate)))
    : num(input.directLabourCost);

  const machining = sum(operations.map(x => {
    const hours = num(x.hours ?? x.timeHours ?? x.time);
    const rate = num(x.rate ?? x.machineRate);
    return hours * rate;
  }));

  const pattern = num(input.patternMakingCost ?? s.patternMakingCost);
  const assembly = num(input.assemblyCost ?? s.assemblyCost);
  const qc = num(input.qualityControlCost ?? s.qualityControlCost);
  const manufacturingLabour = designLabour + directLabour + pattern + assembly + qc;

  const service = services.length
    ? sum(services.map(x => num(x.cost ?? x.total)))
    : num(input.serviceCost ?? s.serviceCost);

  const factoryRate = pct(s.factoryOverheadPct ?? s.factoryOH ?? 0);
  const officeRate = pct(s.officeOverheadPct ?? s.officeOH ?? 0);
  const factoryBase = materialBase + manufacturingLabour + machining;
  const factoryOH = factoryBase * factoryRate;
  const officeBase = materialBase + manufacturingLabour + machining + materialOH + factoryOH + service;
  const officeOH = officeBase * officeRate;

  const subtotal = materialBase + materialOH + manufacturingLabour + machining + service + factoryOH + officeOH;
  const contingency = subtotal * pct(s.contingencyPct ?? s.contPct ?? 0);
  const manufacturingCost = subtotal + contingency;
  const profit = manufacturingCost * pct(s.profitPct ?? s.profit ?? 0);
  const sellingPrice = manufacturingCost + profit;
  const qty = num(input.machineQty ?? input.quantity, 1);

  const result = {
    currency: s.currency || 'ETB',
    quantity: qty,
    lines: {
      rawMaterial: round(rawMaterial),
      casting: round(casting),
      materialBase: round(materialBase),
      standardParts: round(standard),
      materialOH: round(materialOH),
      designLabour: round(designLabour),
      directLabour: round(directLabour),
      patternMaking: round(pattern),
      assembly: round(assembly),
      qualityControl: round(qc),
      manufacturingLabour: round(manufacturingLabour),
      machining: round(machining),
      service: round(service),
      factoryOH: round(factoryOH),
      officeOH: round(officeOH),
      contingency: round(contingency),
      manufacturingCost: round(manufacturingCost),
      profit: round(profit),
      sellingPrice: round(sellingPrice),
      sellingPricePerMachine: round(sellingPrice / Math.max(qty, 1))
    },
    formulaTrace: [
      { key: 'H10', formula: 'H11+H12', value: round(materialBase + standard) },
      { key: 'H11', formula: "Direct raw material J10 + Casting parts J8", value: round(materialBase) },
      { key: 'H12', formula: "standard parts H8", value: round(standard) },
      { key: 'H13', formula: 'H10*0.07', value: round((materialBase + standard) * 0.07) },
      { key: 'H14', formula: "Amimtde DLC and OHC E41", value: round(designLabour + directLabour + pattern + assembly + qc) },
      { key: 'H15', formula: "Machining cost W9", value: round(machining) },
      { key: 'H16', formula: "Service cost L3", value: round(service) },
      { key: 'H17', formula: "Amimtde DLC and OHC H24", value: round(factoryOH) },
      { key: 'H18', formula: "Amimtde DLC and OHC H15", value: round(officeOH) },
      { key: 'H19', formula: 'H10+H13+H14+H15+H16+H17+H18', value: round(materialBase + standard + (materialBase + standard) * 0.07 + manufacturingLabour + machining + service + factoryOH + officeOH) }
    ]
  };
  return result;
}

// -------- Supabase client (server-side) --------
function supabaseServer() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key || !createClient) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
function actor(req){ return clean(req.headers['x-user-id']) || null; }
function tableFor(type){ const map={ revision:'revisions', boq:'boq_items', parts:'parts', mpp:'mpp_operations', materials:'materials', suppliers:'suppliers', quotes:'supplier_quotes', purchaseOrders:'purchase_orders', production:'production_orders', actualCosts:'actual_costs', files:'part_files', estimates:'estimates', audit:'audit_log' }; return map[type]||type; }
async function audit(req, sb, payload) {
  try { await sb.from('audit_log').insert({ ...payload, actor_id: actor(req), ip_address: req.ip }); } catch(e){ console.warn('audit:', e.message); }
}

// ======================== API ROUTES ========================

// --- Health and version ---
app.get('/api/health', (req,res)=>res.json({ok:true, service:'engineering-cost-estimator-v6', version:'6.0.0', time:new Date().toISOString(), database:Boolean(process.env.SUPABASE_URL)}));
app.get('/api/version', (req,res)=>res.json({ok:true, version:'6.0.0', features:[
  'BOQ↔MPP↔Parts↔Materials linkage','Supabase/PostgreSQL','BOQ revision control',
  'automatic geometry weight','supplier comparison','purchase/manufacturing costing',
  'drawing/part files','ERP workflow','Excel formula import/export','audit trail','permissions-ready',
  'Project→BOQ→MPP→Procurement→Production→Actual Cost'
]}));
app.get('/api/formulas', (req,res)=>res.json({version:'6.0.0', formulas:EXCEL_FORMULAS}));

// --- Calculation endpoints ---
app.post('/api/calculate', (req,res)=>{
  try { const result=calculateEngineeringEstimate(req.body||{}); res.json({ok:true, version:'6.0.0', result, trace:result.formulaTrace}); }
  catch(e){ res.status(422).json({ok:false, error:e.message}); }
});
app.post('/api/material/weight', (req,res)=>{
  try { res.json({ok:true, result:materialWeight(req.body||{})}); }
  catch(e){ res.status(422).json({ok:false, error:e.message}); }
});

// --- MPP calculation ---
app.post('/api/mpp/calculate', (req,res)=>{
  try{
    const rows=Array.isArray(req.body.operations)?req.body.operations:[];
    const result=rows.map((o,i)=>{
      const setup=num(o.setup_min), cycle=num(o.cycle_min), qty=num(o.qty,1);
      const hours=(setup+cycle*qty)/60;
      return {...o, row:i, hours:round(hours), machineCost:round(hours*num(o.machine_rate??o.rate)), labourCost:round(hours*num(o.labour_rate)), processCost:round(hours*num(o.process_rate)), totalCost:round(hours*(num(o.machine_rate??o.rate)+num(o.labour_rate)+num(o.process_rate)))};
    });
    res.json({ok:true, result, total:round(sum(result.map(x=>x.totalCost)))});
  }catch(e){ res.status(422).json({ok:false, error:e.message}); }
});

// --- Procurement comparison ---
app.post('/api/procurement/compare', (req,res)=>{
  try{
    const q=Array.isArray(req.body.quotes)?req.body.quotes:[], qty=num(req.body.qty,1), fx=num(req.body.fxRate,1);
    const rows=q.map(x=>{
      const base=num(x.unit_price??x.price_usd_kg)*qty, freight=num(x.freight), duty=base*pct(x.duty_pct), other=num(x.other_cost);
      const landed=(base+freight+duty+other)*fx;
      return {...x, baseCost:round(base*fx), dutyCost:round(duty*fx), landedCost:round(landed), costPerUnit:round(landed/Math.max(qty,1))};
    }).sort((a,b)=>a.landedCost-b.landedCost);
    res.json({ok:true, rows, recommended:rows[0]||null});
  }catch(e){ res.status(422).json({ok:false, error:e.message}); }
});

// --- Excel import/export ---
app.post('/api/import/inspect', upload.single('file'), (req,res)=>{
  if(!req.file)return res.status(400).json({ok:false, error:'No Excel file uploaded.'});
  try{const wb=XLSX.readFile(req.file.path,{cellFormula:true,cellNF:true,cellText:false});res.json({ok:true, version:'6.0.0', file:req.file.originalname, sheets:workbookSummary(wb), sheetNames:wb.SheetNames});}
  catch(e){res.status(422).json({ok:false, error:e.message});}finally{safe(()=>fs.unlinkSync(req.file.path));}
});
app.post('/api/import/excel', upload.single('file'), (req,res)=>{
  if(!req.file)return res.status(400).json({ok:false, error:'No Excel file uploaded.'});
  try{const wb=XLSX.readFile(req.file.path,{cellFormula:true,cellNF:true,cellText:false});const sheets=workbookSummary(wb);const requested=req.body.sheet||wb.SheetNames[0];const ws=wb.Sheets[requested];const rows=rowsFromSheet(ws);const mapping=req.body.mapping?JSON.parse(req.body.mapping):{};const normalized=normalizeRows(rows,mapping);res.json({ok:true, version:'6.0.0', file:req.file.originalname, sheets, selectedSheet:requested, rows:normalized, rawRows:rows.slice(0,100), formulas:XLSX.utils.sheet_to_json(ws||{}, {header:1,defval:null,raw:false})});}
  catch(e){res.status(422).json({ok:false, error:e.message});}finally{safe(()=>fs.unlinkSync(req.file.path));}
});
app.post('/api/export/excel', (req,res)=>{
  try{
    const wb=XLSX.utils.book_new(), payload=req.body||{};
    const sheets=payload.sheets||{Estimate:payload.result||payload};
    for(const [name,data] of Object.entries(sheets)){
      let ws;
      if(Array.isArray(data)) ws=XLSX.utils.json_to_sheet(data);
      else ws=XLSX.utils.json_to_sheet([data]);
      XLSX.utils.book_append_sheet(wb, ws, String(name).slice(0,31));
    }
    const out=path.join(UPLOAD_DIR,'v6_estimate_'+Date.now()+'.xlsx');
    XLSX.writeFile(wb,out,{bookType:'xlsx',cellFormula:true});
    res.download(out,'engineering-estimate-v6.xlsx',()=>safe(()=>fs.unlinkSync(out)));
  }catch(e){ res.status(422).json({ok:false, error:e.message}); }
});
// Helpers for Excel import
function workbookSummary(wb) {
  return wb.SheetNames.map(name => {
    const ws = wb.Sheets[name];
    const ref = ws['!ref'] || 'A1';
    const range = XLSX.utils.decode_range(ref);
    let formulas = 0, cells = 0;
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        cells++;
        if (typeof cell.f === 'string' || (typeof cell.v === 'string' && cell.v.startsWith('='))) formulas++;
      }
    }
    return { name, range: ref, rows: range.e.r + 1, columns: range.e.c + 1, cells, formulas };
  });
}
function rowsFromSheet(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
}
function autoMap(headers) {
  const tests = {
    part: /part|item|code|number|no\.?$/i,
    name: /part.?name|description|item.?name|name/i,
    qty: /qty|quantity|amount/i,
    material: /material|grade|steel|metal/i,
    spec: /spec|size|dimension|designation/i,
    process: /process|operation|manufact|mpp/i,
    weight: /weight|kg/i,
    cost: /cost|price|unit.?cost/i,
    // new fields
    materialType: /material type|type/i,
    materialProfile: /material profile|profile/i,
    blankSize: /blank size|blank/i,
    drawingNo: /drawing no|drawing number|dwg no/i,
    operationTime: /operation time|op time/i
  };
  const out = {};
  for (const [k, re] of Object.entries(tests)) out[k] = headers.findIndex(h => re.test(clean(h)));
  return out;
}
function normalizeRows(rows, mapping = {}) {
  if (!rows.length) return [];
  const headers = rows[0].map(clean);
  const m = { ...autoMap(headers), ...mapping };
  return rows.slice(1).map((r, i) => {
    const row = {
      id: clean(r[m.part] ?? `P-${i + 1}`),
      name: clean(r[m.name]),
      qty: num(r[m.qty], 1),
      material: clean(r[m.material]),
      specification: clean(r[m.spec]),
      process: clean(r[m.process]),
      weightKg: num(r[m.weight]),
      unitCost: num(r[m.cost]),
      materialType: clean(r[m.materialType]),
      materialProfile: clean(r[m.materialProfile]),
      blankSize: clean(r[m.blankSize]),
      drawingNo: clean(r[m.drawingNo]),
      operationTime: num(r[m.operationTime])
    };
    // Also map 'operationTime' to cycle_min if needed (for MPP)
    return row;
  }).filter(x => x.name || x.id || x.material);
}

// --- Workflow summary ---
app.get('/api/workflow/:projectId', async(req,res)=>{
  try{
    const sb = supabaseServer();
    if (!sb) return res.status(503).json({ok:false, error:'Supabase not configured'});
    const pid = req.params.projectId;
    const out = { project_id: pid };
    const tables = { boq:'boq_items', parts:'parts', mpp:'mpp_operations', materials:'materials', quotes:'supplier_quotes', po:'purchase_orders', production:'production_orders', actual:'actual_costs', estimates:'estimates' };
    for (const [key, t] of Object.entries(tables)) {
      const r = await sb.from(t).select('*', {count:'exact', head:false}).eq('project_id', pid);
      if (r.error) throw r.error;
      out[key] = { count: r.count || 0, data: r.data || [] };
    }
    const actual = out.actual.data.reduce((a,x)=>a+num(x.total_cost),0);
    const planned = out.estimates.data.length ? num(out.estimates.data[0]?.result?.lines?.manufacturingCost) : 0;
    out.variance = { plannedManufacturingCost: round(planned), actualCost: round(actual), variance: round(actual-planned), variancePct: planned ? round((actual-planned)/planned*100) : 0 };
    res.json({ok:true, workflow:out});
  }catch(e){ res.status(e.statusCode||400).json({ok:false, error:e.message}); }
});

// --- Generic CRUD for all tables (Supabase) ---
app.get('/api/data/:type', async(req,res)=>{
  try{
    const sb=supabaseServer(); if(!sb) return res.status(503).json({ok:false, error:'Supabase not configured'});
    const table=tableFor(req.params.type);
    let q=sb.from(table).select('*');
    if(req.query.project_id) q=q.eq('project_id',req.query.project_id);
    if(req.query.revision_id) q=q.eq('revision_id',req.query.revision_id);
    if(req.query.part_id) q=q.eq('part_id',req.query.part_id);
    if(req.query.limit) q=q.limit(Math.min(num(req.query.limit,1000),5000));
    q=q.order('created_at',{ascending:false});
    const {data,error}=await q; if(error) throw error;
    res.json({ok:true, data});
  }catch(e){ res.status(e.statusCode||400).json({ok:false, error:e.message}); }
});
app.get('/api/data/:type/:id', async(req,res)=>{
  try{
    const sb=supabaseServer(); if(!sb) return res.status(503).json({ok:false, error:'Supabase not configured'});
    const {data,error}=await sb.from(tableFor(req.params.type)).select('*').eq('id',req.params.id).single();
    if(error) throw error;
    res.json({ok:true, data});
  }catch(e){ res.status(404).json({ok:false, error:e.message}); }
});
app.post('/api/data/:type', async(req,res)=>{
  try{
    const sb=supabaseServer(); if(!sb) return res.status(503).json({ok:false, error:'Supabase not configured'});
    const payload=req.body||{};
    const {data,error}=await sb.from(tableFor(req.params.type)).insert(payload).select().single();
    if(error) throw error;
    await audit(req, sb, {project_id:payload.project_id, action:'CREATE', entity_type:req.params.type, entity_id:data.id, after_data:data});
    res.status(201).json({ok:true, data});
  }catch(e){ res.status(422).json({ok:false, error:e.message}); }
});
app.patch('/api/data/:type/:id', async(req,res)=>{
  try{
    const sb=supabaseServer(); if(!sb) return res.status(503).json({ok:false, error:'Supabase not configured'});
    const table=tableFor(req.params.type);
    const oldQ=await sb.from(table).select('*').eq('id',req.params.id).single(); if(oldQ.error) throw oldQ.error;
    const {data,error}=await sb.from(table).update(req.body||{}).eq('id',req.params.id).select().single();
    if(error) throw error;
    await audit(req, sb, {project_id:data.project_id, action:'UPDATE', entity_type:req.params.type, entity_id:data.id, before_data:oldQ.data, after_data:data});
    res.json({ok:true, data});
  }catch(e){ res.status(422).json({ok:false, error:e.message}); }
});
app.delete('/api/data/:type/:id', async(req,res)=>{
  try{
    const sb=supabaseServer(); if(!sb) return res.status(503).json({ok:false, error:'Supabase not configured'});
    const table=tableFor(req.params.type);
    const oldQ=await sb.from(table).select('*').eq('id',req.params.id).single(); if(oldQ.error) throw oldQ.error;
    const {error}=await sb.from(table).delete().eq('id',req.params.id);
    if(error) throw error;
    await audit(req, sb, {project_id:oldQ.data.project_id, action:'DELETE', entity_type:req.params.type, entity_id:req.params.id, before_data:oldQ.data});
    res.json({ok:true});
  }catch(e){ res.status(422).json({ok:false, error:e.message}); }
});

// --- Revision snapshot ---
app.post('/api/revisions/snapshot', async(req,res)=>{
  try{
    const sb=supabaseServer(); if(!sb) return res.status(503).json({ok:false, error:'Supabase not configured'});
    const project_id = req.body.project_id;
    if(!project_id) throw new Error('project_id required');
    const revision_no = clean(req.body.revision_no||'R1');
    const tables=['boq_items','parts','mpp_operations','materials','supplier_quotes'];
    const snap={};
    for(const t of tables){
      let q=sb.from(t).select('*').eq('project_id',project_id);
      if(t==='boq_items') q=q.eq('revision_id',req.body.revision_id||'00000000-0000-0000-0000-000000000000');
      const r=await q; if(r.error) throw r.error;
      snap[t]=r.data||[];
    }
    const ins=await sb.from('revisions').insert({project_id, revision_no, reason:req.body.reason||'Snapshot', status:'Draft', snapshot:snap, created_by:actor(req)}).select().single();
    if(ins.error) throw ins.error;
    await audit(req, sb, {project_id, action:'REVISION_SNAPSHOT', entity_type:'revision', entity_id:ins.data.id, after_data:ins.data});
    res.status(201).json({ok:true, revision:ins.data, snapshot:snap});
  }catch(e){ res.status(422).json({ok:false, error:e.message}); }
});

// --- Project save (compatibility with V5) ---
app.post('/api/project/save', async(req,res)=>{
  try{
    const sb=supabaseServer(); if(!sb) return res.status(503).json({ok:false, error:'Supabase not configured'});
    const p=req.body.project||{};
    const row={name:clean(p.name||p.projectName||'Untitled project'), customer:clean(p.customer), metadata:req.body, machine_qty:num(p.machineQty??p.machine_qty,1), currency:p.currency||'ETB', fx_rate:num(p.fxRate??p.fx_rate,150), status:p.status||'Draft'};
    let q;
    if(p.id) q=await sb.from('projects').update(row).eq('id',p.id).select().single();
    else q=await sb.from('projects').insert(row).select().single();
    if(q.error) throw q.error;
    await audit(req, sb, {project_id:q.data.id, action:p.id?'UPDATE':'CREATE', entity_type:'project', entity_id:q.data.id, after_data:q.data});
    res.json({ok:true, project:q.data});
  }catch(e){ res.status(422).json({ok:false, error:e.message}); }
});
app.get('/api/project/:id', async(req,res)=>{
  try{
    const sb=supabaseServer(); if(!sb) return res.status(503).json({ok:false, error:'Supabase not configured'});
    const {data,error}=await sb.from('projects').select('*').eq('id',req.params.id).single();
    if(error) throw error;
    res.json({ok:true, project:data});
  }catch(e){ res.status(404).json({ok:false, error:e.message}); }
});

// --- Serve frontend (Express 5 compatible) ---
// Serve static files from the project root (where index.html lives)
app.use(express.static(ROOT));
// Catch-all – serve index.html for client-side routing
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>{
  console.log(`Engineering Cost Estimator V6 running on http://localhost:${PORT}`);
  console.log('Workflow: Project -> BOQ -> MPP -> Materials -> Procurement -> Production -> Actual Cost');
});
