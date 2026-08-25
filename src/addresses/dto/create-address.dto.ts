import { IsRef } from "../../common/validation/decorators";

/**
 * A ref and nothing else: every address this endpoint creates is the same kind of wallet at
 * the next free index. An operator wallet backing the operator's shared balance is created
 * here like any other, under a ref of the operator's choosing.
 */
export class CreateAddressDto {
  @IsRef()
  ref!: string;
}
