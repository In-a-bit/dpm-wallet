import { IsRef } from "../../common/validation/decorators";

/**
 * There is no `role` field: every address this endpoint creates is a user wallet at the next
 * free index. An operator wallet backing the operator's shared balance is created here like any
 * other, under a ref of the operator's choosing.
 */
export class CreateAddressDto {
  @IsRef()
  ref!: string;
}
