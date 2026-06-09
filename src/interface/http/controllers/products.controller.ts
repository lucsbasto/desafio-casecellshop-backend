import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiNotFoundResponse, ApiTags } from '@nestjs/swagger';
import { ListProductsUseCase } from '../../../application/use-cases/list-products.usecase';
import { ProductDto } from '../dto/product.dto';
import { ErrorDto } from '../dto/error.dto';

@ApiTags('catalog')
@Controller('products')
export class ProductsController {
  constructor(private readonly listProducts: ListProductsUseCase) {}

  @Get()
  @ApiOkResponse({ type: [ProductDto], description: 'Catálogo (servido via cache com TTL)' })
  async findAll(): Promise<ProductDto[]> {
    return this.listProducts.listAll();
  }

  @Get(':id')
  @ApiOkResponse({ type: ProductDto })
  @ApiNotFoundResponse({ type: ErrorDto })
  async findOne(@Param('id') id: string): Promise<ProductDto> {
    return this.listProducts.getById(id);
  }
}
