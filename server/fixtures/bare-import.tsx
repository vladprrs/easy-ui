import lodash from "lodash";
import { z } from "zod";
export const definition={props:z.object({}),description:"bad import",example:{}};
export default function Bad(){return lodash.noop();}
