// Pending: Starter MCP quota exhausted after the main design was created.
// Apply this targeted correction when the connector becomes available again.
const page=await figma.getNodeByIdAsync('0:1');
await figma.setCurrentPageAsync(page);
await figma.loadFontAsync({family:'Inter',style:'Extra Bold'});
await figma.loadFontAsync({family:'Noto Sans SC',style:'Regular'});
const changed=[];
for(const id of ['5:35','5:36','5:202','5:203']) {
  const n=await figma.getNodeByIdAsync(id);
  n.lineHeight={unit:'PERCENT',value:120};changed.push(n.id);
}
const mobile=await figma.getNodeByIdAsync('5:182');mobile.resize(390,2400);changed.push(mobile.id);
const header=await figma.getNodeByIdAsync('5:183');header.resize(header.width,184);changed.push(header.id);
const hero=await figma.getNodeByIdAsync('5:200');hero.resize(hero.width,392);changed.push(hero.id);
return {changedNodeIds:changed};
