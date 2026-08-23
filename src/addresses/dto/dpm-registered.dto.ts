import { IsBoolean } from "class-validator";

export class DpmRegisteredDto {
  /** Defaults to true, so the gateway can confirm a registration with an empty body. */
  @IsBoolean()
  registered: boolean = true;
}
