'use strict';
function withMetadata(item,previous,now=new Date().toISOString()){
 const saved={...item,updatedAt:now};
 if(!previous)saved.createdAt=now;
 else if(previous.createdAt!==undefined)saved.createdAt=previous.createdAt;
 else delete saved.createdAt;
 return saved;
}
module.exports={withMetadata};
