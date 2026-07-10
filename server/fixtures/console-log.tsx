import { z } from "zod";
console.log("author output must not be IPC");
export const definition={props:z.object({}),description:"logs safely",example:{}};
export default function Logs(){return null;}
