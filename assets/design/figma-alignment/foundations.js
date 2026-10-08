// Run with the Figma Plugin API through the Figma connector.
// The helper patterns below follow figma-generate-library's bundled scripts.
const page = await figma.getNodeByIdAsync('0:1');
await figma.setCurrentPageAsync(page);
page.name = 'CBCT · Grid & responsive UI';
await Promise.all(['Regular', 'Bold', 'Extra Bold'].map(style => figma.loadFontAsync({family:'Inter',style})));
await figma.loadFontAsync({family:'Noto Sans SC',style:'Regular'});
async function createVariableCollection(name, modeNames) {
  const collection = figma.variables.createVariableCollection(name), modeIds = {};
  collection.renameMode(collection.modes[0].modeId, modeNames[0]);
  modeIds[modeNames[0]] = collection.modes[0].modeId;
  for (let i=1;i<modeNames.length;i++) modeIds[modeNames[i]]=collection.addMode(modeNames[i]);
  return {collection,modeIds};
}
const primitive = await createVariableCollection('CBCT / Primitives',['Light']);
const semantic = await createVariableCollection('CBCT / Semantic',['Light']);
const vars = {};
const colors = {paper:'#FFFDF8',surface:'#FFFFFF',ink:'#222222',muted:'#666666',accent:'#6C5CE7',yellow:'#FFF2A8',blue:'#E6F7FF',lavender:'#F1ECFF',pink:'#FFE8EE',mint:'#B5F2C8',peach:'#FFE08A',takeaway:'#FFF7D6'};
function rgb(hex){return {r:parseInt(hex.slice(1,3),16)/255,g:parseInt(hex.slice(3,5),16)/255,b:parseInt(hex.slice(5,7),16)/255};}
for (const [name,value] of Object.entries(colors)) {
  const raw=figma.variables.createVariable('palette/'+name,primitive.collection,'COLOR');raw.scopes=[];raw.setValueForMode(primitive.modeIds.Light,{...rgb(value),a:1});
  const v=figma.variables.createVariable('color/'+name,semantic.collection,'COLOR');v.scopes=['FRAME_FILL','SHAPE_FILL','TEXT_FILL','STROKE_COLOR'];v.setValueForMode(semantic.modeIds.Light,figma.variables.createVariableAlias(raw));v.setVariableCodeSyntax('WEB','var(--fun-'+name+')');vars[name]=v.id;
}
const spacingKeys={8:'15bb1c0f339146e931cf0dc15f89ed57dcbd907e',12:'fabe3eb617318c0a59ce59bbea8eebdf1fa7d14c',16:'16bc6f84b6e7e20e4234ef79030ee580ec0f4505',24:'be3115966ea99eef888c9f25751b54695c7e88d2',32:'9acadea8b7c7c9884455b896e21c88b8bc62d6da'};
for (const [value,key] of Object.entries(spacingKeys)) {
  const raw=await figma.variables.importVariableByKeyAsync(key);
  const v=figma.variables.createVariable('space/'+value,semantic.collection,'FLOAT');v.scopes=['GAP'];v.setValueForMode(semantic.modeIds.Light,figma.variables.createVariableAlias(raw));v.setVariableCodeSyntax('WEB','var(--fun-space-'+value+')');vars['space'+value]=v.id;
}
for(const [name,value,scope] of [['radius',24,'CORNER_RADIUS'],['pill',999,'CORNER_RADIUS'],['control',40,'WIDTH_HEIGHT'],['border',1.5,'STROKE_FLOAT']]) {
  const raw=figma.variables.createVariable('number/'+name,primitive.collection,'FLOAT');raw.scopes=[];raw.setValueForMode(primitive.modeIds.Light,value);
  const v=figma.variables.createVariable('size/'+name,semantic.collection,'FLOAT');v.scopes=[scope];v.setValueForMode(semantic.modeIds.Light,figma.variables.createVariableAlias(raw));v.setVariableCodeSyntax('WEB','var(--fun-'+name+')');vars[name]=v.id;
}
function cartesianProduct(arrays){return arrays.reduce((acc,curr)=>acc.flatMap(c=>curr.map(v=>[...c,v])),[[]]);}
async function createComponentWithVariants(config) {
  const axes=Object.keys(config.axes), combos=cartesianProduct(Object.values(config.axes)), components=[], labels=[];
  for(const combo of combos) {
    const c=figma.createComponent();page.appendChild(c);c.name=axes.map((a,i)=>a+'='+combo[i]).join(', ');c.resize(160,40);c.layoutMode='HORIZONTAL';c.primaryAxisAlignItems='CENTER';c.counterAxisAlignItems='CENTER';c.paddingLeft=16;c.paddingRight=16;c.cornerRadius=999;c.strokeWeight=1.5;
    const isPrimary=combo[0]==='Primary', tone=config.name==='Button'?(isPrimary?'ink':'surface'):combo[0].toLowerCase();
    const paint=figma.variables.setBoundVariableForPaint({type:'SOLID',color:rgb(colors[tone])},'color',await figma.variables.getVariableByIdAsync(vars[tone]));c.fills=[paint];c.strokes=[{type:'SOLID',color:rgb(colors.ink)}];c.setBoundVariable('cornerRadius',await figma.variables.getVariableByIdAsync(vars.pill));c.setBoundVariable('height',await figma.variables.getVariableByIdAsync(vars.control));
    if(combo[1]==='Pressed')c.opacity=.72;if(combo[1]==='Selected')c.strokeWeight=2;
    const t=figma.createText();t.fontName={family:'Inter',style:'Bold'};t.fontSize=12;t.characters=config.name==='Button'?'Button':'Label';t.fills=[{type:'SOLID',color:rgb(isPrimary?colors.surface:colors.ink)}];c.appendChild(t);
    const prop=c.addComponentProperty('Label','TEXT',t.characters);t.componentPropertyReferences={characters:prop};components.push(c);labels.push(prop);
  }
  const set=figma.combineAsVariants(components,page);set.name='CBCT / '+config.name;set.description=config.description;
  components.forEach((c,i)=>{c.x=24+(i%2)*184;c.y=24+Math.floor(i/2)*64;});set.resize(392,48+Math.ceil(components.length/2)*64);set.x=-500;set.y=config.name==='Button'?0:240;
  return {setId:set.id,variants:components.map((c,i)=>({id:c.id,name:c.name,labelProperty:labels[i]}))};
}
const button=await createComponentWithVariants({name:'Button',axes:{Tone:['Primary','Secondary'],State:['Default','Pressed']},description:'40px capsule actions, 1.5px ink outline. Matches FunButtonStyle; label exposed as TEXT.'});
const pill=await createComponentWithVariants({name:'Pill',axes:{Tone:['Yellow','Blue','Lavender','Pink','Mint'],State:['Default','Selected']},description:'Navigation and topic pills, pastel tones from the supplied SVG. 40px navigation; topic instances resize to 32px.'});
return {pageId:page.id,variables:vars,colors,button,pill,collectionIds:[primitive.collection.id,semantic.collection.id],createdNodeIds:[page.id,button.setId,...button.variants.map(v=>v.id),pill.setId,...pill.variants.map(v=>v.id)]};
