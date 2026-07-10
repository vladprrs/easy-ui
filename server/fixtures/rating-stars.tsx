import { useState } from "react";
import { z } from "zod";

export const definition = {
  props: z.strictObject({ value: z.number().min(0).max(5), emit: z.custom<(event:string,payload:unknown)=>void>().optional() }),
  events: ["press"],
  slots: [],
  description: "An interactive five-star rating",
  example: { value: 3 },
};

export default function RatingStars(props: z.infer<typeof definition.props>) {
  const [value,setValue]=useState(props.value);
  return <button onClick={()=>{setValue(value+1);props.emit?.("press",{value:value+1});}}>{"★".repeat(value)}</button>;
}
